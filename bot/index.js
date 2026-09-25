const {
  Client,
  GatewayIntentBits,
  Events,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ChannelType,
} = require('discord.js');
const { commands, loadLocalFeatures } = require('./commands');
const { createStore } = require('../services/store');
const { validateUsername, validateChannel, sameChannel } = require('../services/validators');
const GUILD_ID = String(process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || '').trim();
const Tracker = require('../services/tracker');
const roblox = require('../services/roblox');
const tiktok = require('../services/tiktok');
const { buildEmbed, buildComponents, buildBoardView, chunkDiscordLines, truncateDiscordText, sanitizeChoices, groupInGame, topGames } = require('../services/discord');

const BRAND = 0x7c5cff;
const I = { ok: '✓', no: '×', on: '●', off: '○', game: '◆', arrow: '→', dot: '•', gear: '⌘', clock: '◷' };
const localFeatures = loadLocalFeatures();
let tracker = null;
let sender = null;
let store = null;
let discordClient = null;
let initialized = false;

function formatDuration(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).slice(0, 3).join(' ');
}
function when(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : `<t:${Math.floor(d.getTime() / 1000)}:R>`;
}
function storeFor() {
  if (!store) store = createStore();
  return store;
}
function safeGuildName(guild) {
  return guild?.name || `Server ${guild?.id || 'unknown'}`;
}
function trackerFor() {
  if (tracker) return tracker;
  const s = storeFor();
  tracker = new Tracker(null, {
    store: s,
    intervalMs: s.getSettings().intervalMs,
    notify: async status => sender ? sender(status) : undefined,
  });
  return tracker;
}
function statusLine(s) {
  if (!s) return `${I.off} No data yet`;
  if (!s.resolved) return `${I.no} ${s.error || 'Unresolved'}`;
  if (s.inGame) return `${I.game} In game${s.gameName ? ` — ${s.gameName}` : ''}`;
  if (s.status === 'Online') return `${I.on} Online`;
  return `${I.off} ${s.status || 'Offline'}`;
}
function getSnapshot(t, username) {
  return t.getSnapshot().find(s => s.username.toLowerCase() === username.toLowerCase());
}
function manage(i) { return i.inGuild() && i.memberPermissions?.has(PermissionFlagsBits.ManageGuild); }
async function replyError(i, e) {
  const msg = e?.message || 'Something went wrong.';
  const payload = { content: `${I.no} ${msg}`, flags: MessageFlags.Ephemeral };
  try {
    if (i.deferred || i.replied) await i.followUp(payload);
    else await i.reply(payload);
  } catch {}
}
async function register(client) {
  const json = commands.map(c => c.toJSON());

  // Alicia Tracker is a single-server application. Remove any legacy global
  // commands first; otherwise Discord can display both global and guild copies.
  try {
    await client.application.commands.set([]);
    console.log('[bot] cleared legacy global application commands');
  } catch (e) {
    console.warn(`[bot] could not clear legacy global commands: ${e.message}`);
  }

  await client.application.commands.set(json, GUILD_ID);
  console.log(`[bot] synchronized ${json.length} guild commands for ${GUILD_ID}`);
}

async function safeFetchChannel(client, channelId) {
  if (!channelId) return null;
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch?.isTextBased() || typeof ch.send !== 'function') return null;
    if (ch.guildId && ch.guildId !== GUILD_ID) return null;
    return ch;
  } catch (e) {
    if (e?.code === 50001 || e?.code === 10003) {
      const current = storeFor().getSettings().notifyChannelId;
      if (current === channelId) storeFor().setSettings({ notifyChannelId: null });
      const userChannels = storeFor().getUserChannels();
      for (const [uname, cid] of Object.entries(userChannels)) {
        if (cid === channelId) storeFor().setUserChannel(uname, null);
      }
      if (storeFor().getTiktokChannel() === channelId) storeFor().setTiktokChannel(null);
      console.warn(`[bot] notification channel unavailable (${channelId}); cleared references.`);
    } else {
      console.warn(`[bot] notification channel unavailable (${channelId}): ${e.message}`);
    }
    return null;
  }
}

// In-memory send queue & deduplication to keep notifications rate-limit safe
const sendQueues = new Map(); // channelId -> Promise chain
const recentSends = new Map(); // dedupKey -> timestamp

function canSendAlert(key, windowMs = 15000) {
  const now = Date.now();
  const last = recentSends.get(key) || 0;
  if (now - last < windowMs) return false;
  recentSends.set(key, now);
  // cleanup old keys
  if (recentSends.size > 200) {
    for (const [k, time] of recentSends) {
      if (now - time > 60000) recentSends.delete(k);
    }
  }
  return true;
}

function queueChannelSend(channelId, task) {
  const current = sendQueues.get(channelId) || Promise.resolve();
  const next = current
    .then(task)
    .then(() => new Promise(r => setTimeout(r, 1200)))
    .catch(e => console.warn(`[bot] queue send failed for ${channelId}:`, e.message))
    .finally(() => { if (sendQueues.get(channelId) === next) sendQueues.delete(channelId); });
  sendQueues.set(channelId, next);
  return next;
}

function bindSender(client) {
  const ALLY_USERNAME = 'ally_cutie142';
  sender = async status => {
    const s = storeFor();
    const settings = s.getSettings();
    // Quiet mode: fully mute all Roblox alerts (manual commands still work).
    if (s.getQuiet()) return;
    const username = status.username ? status.username.toLowerCase() : '';
    const userChannelId = s.getUserChannel(username);
    const targetChannelId = userChannelId || settings.notifyChannelId;
    if (!targetChannelId) return;

    // Game-only mode: silence non-game transitions. Game joins, changes, and
    // leaves still alert; online/offline are dropped silently.
    if (s.getGameOnly() && ['online', 'offline'].includes(status.eventType)) return;

    // Deduplication check: prevent identical status transitions from posting multiple times
    const dedupKey = `${targetChannelId}:${username}:${status.eventType}:${status.status}:${status.gameId || status.placeId || ''}`;
    if (!canSendAlert(dedupKey)) return;

    const ch = await safeFetchChannel(client, targetChannelId);
    if (!ch) return;

    return queueChannelSend(targetChannelId, async () => {
      try {
        await ch.send({ embeds: [buildEmbed(status, { serverInfo: s.getServerInfo(), compactLinks: s.getCompactLinks() })], components: buildComponents(status) || [] });
      } catch (e) {
        console.warn(`[bot] notification send failed for ${username}:`, e.message);
      }

      // Ally solo @everyone burst: fires after her gameJoin alert when
      // she is the only tracked user currently in-game and the toggle is on.
      const burstOn = s.getAllyPing();
      if (burstOn && username === ALLY_USERNAME && status.eventType === 'gameJoin' && trackerFor().isSoloInGame(ALLY_USERNAME)) {
        const burstMessages = [
          `@everyone guys alicia black play — ${status.displayName || status.username}`,
          `@everyone guys go bro cmon (${status.displayName || status.username})`,
          `@everyone last call ${status.displayName || status.username} is in ${status.gameName || 'a game'}`,
        ];
        for (const text of burstMessages) {
          try {
            await ch.send({ content: text });
          } catch (e) {
            console.warn(`[bot] burst send failed (${text.slice(0, 20)}...):`, e.message);
          }
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    });
  };
}

// === Experimental TikTok LIVE poller ===
// Independent of the Roblox tracker. Thin, slow (default 60s), only active
// when `/settings tiktok on` AND at least one tracked user has a linked
// handle. Sends LIVE / ended alerts through the same queue/sender path.
let tiktokTimer = null;
let tiktokRunning = false;
let tiktokTicking = false;
let tiktokState = new Map(); // handle -> boolean (was live?)

function tiktokTargets(s) {
  const linked = s.getUsers()
    .filter(u => u.enabled !== false && u.tiktokHandle)
    .map(u => ({ username: u.username, handle: u.tiktokHandle }));
  const standalone = (s.getTiktokWatch() || [])
    .filter(h => !linked.some(l => l.handle === h))
    .map(h => ({ username: h, handle: h }));
  return [...linked, ...standalone];
}

function stopTiktokPoller() {
  tiktokRunning = false;
  if (tiktokTimer) { clearTimeout(tiktokTimer); tiktokTimer = null; }
}

function startTiktokPoller(s) {
  if (tiktokRunning) return;
  const enabled = s.getTiktokLive();
  const targets = tiktokTargets(s);
  if (!enabled || !targets.length) { stopTiktokPoller(); return; }
  tiktokRunning = true;
  const interval = Math.max(10000, s.getTiktokPoint());
  const tick = async () => {
    if (!tiktokRunning) return;
    if (tiktokTicking) return; // never overlap ticks — a slow TikTok request
    const store = storeFor();
    if (!store.getTiktokLive()) { stopTiktokPoller(); return; }
    const list = tiktokTargets(store);
    if (!list.length) { stopTiktokPoller(); return; }
    tiktokTicking = true;
    try {
      const results = await tiktok.checkMany(list.map(x => x.handle), 2);
      for (const item of results) {
        const [handle, status] = item;
        if (!status || status.unknown) continue; // never fire on API hiccups
        const target = list.find(x => x.handle === handle);
        if (!target) continue;
        const wasLive = tiktokState.get(handle) || false;
        if (status.live && !wasLive) {
          tiktokState.set(handle, true);
          emitTikTokAlert(store, target, status, 'live').catch(e => console.warn(`[tiktok] live alert failed for ${handle}:`, e.message));
        } else if (!status.live && wasLive) {
          tiktokState.set(handle, false);
          emitTikTokAlert(store, target, status, 'ended').catch(e => console.warn(`[tiktok] ended alert failed for ${handle}:`, e.message));
        }
      }
    } catch (e) {
      console.warn(`[tiktok] poll failed: ${e.message}`);
    } finally {
      tiktokTicking = false;
      if (tiktokRunning) tiktokTimer = setTimeout(tick, interval);
    }
  };
  tiktokTimer = setTimeout(tick, interval);
}

async function emitTikTokAlert(s, target, status, kind) {
  if (!sender) return;
  if (s.getQuiet()) return;
  const userChannelId = s.getUserChannel(target.username.toLowerCase());
  const targetChannelId = s.getTiktokChannel() || userChannelId || s.getSettings().notifyChannelId;
  if (!targetChannelId) return;
  const dedupKey = `tiktok:${targetChannelId}:${target.handle}:${kind}`;
  if (!canSendAlert(dedupKey, 30000)) return;
  const ch = await safeFetchChannel(discordClient, targetChannelId);
  if (!ch) return;
  const title = kind === 'live' ? (status.title || `${status.nickname} is LIVE`) : `${status.nickname} ended the stream`;
  const color = kind === 'live' ? 0xff2d55 : 0x9aa0a6;
  const desc = kind === 'live'
    ? `**${target.username}** went LIVE on TikTok — [watch](https://www.tiktok.com/@${target.handle}/live)${status.title ? `\n${status.title}` : ''}`
    : `**${target.username}** is no longer live (TikTok).`;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(color)
    .setFooter({ text: 'Experimental TikTok tracker' });
  if (status.avatar) embed.setThumbnail(status.avatar);
  return queueChannelSend(targetChannelId, () => ch.send({ embeds: [embed] }).catch(e => console.warn(`[tiktok] send failed for ${target.handle}:`, e.message)));
}

async function initializeTargetGuild(client) {
  if (!GUILD_ID) throw new Error('DISCORD_GUILD_ID is not configured.');
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) throw new Error(`Configured Discord server ${GUILD_ID} is not accessible to this bot.`);
  storeFor();
  const t = trackerFor();
  bindSender(client);
  if (!t.timer) t.start();
  startTiktokPoller(storeFor());
  await localFeatures?.onReady?.({ client, store: storeFor(), tracker: t });
  initialized = true;
  console.log(`[bot] ready: ${safeGuildName(guild)} (${guild.id})`);
}

async function start() {
  if (!GUILD_ID) {
    console.error('[bot] DISCORD_GUILD_ID is not configured');
    return null;
  }
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] DISCORD_BOT_TOKEN is not configured');
    return null;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  discordClient = client;

  client.once(Events.ClientReady, async () => {
    console.log(`[bot] logged in as ${client.user?.tag || client.user?.username || 'unknown'}`);
    try {
      for (const guild of [...client.guilds.cache.values()]) {
        if (guild.id !== GUILD_ID) {
          console.log(`[bot] leaving unauthorized guild ${safeGuildName(guild)} (${guild.id})`);
          await guild.leave().catch(e => console.warn(`[bot] failed to leave ${guild.id}: ${e.message}`));
        }
      }
      await register(client);
      await initializeTargetGuild(client);
    } catch (e) {
      console.error(`[bot] initialization failed: ${e.message}`);
    }
  });

  client.on(Events.GuildCreate, async guild => {
    if (guild.id !== GUILD_ID) {
      console.log(`[bot] leaving unauthorized guild ${safeGuildName(guild)} (${guild.id})`);
      await guild.leave().catch(e => console.warn(`[bot] failed to leave ${guild.id}: ${e.message}`));
      return;
    }
    try { await initializeTargetGuild(client); }
    catch (e) { console.error(`[bot] target guild initialization failed: ${e.message}`); }
  });

  client.on(Events.InteractionCreate, async i => {
    try {
      if (i.isAutocomplete()) { await handleAutocomplete(i); return; }
      if (!i.isChatInputCommand()) return;
      await handle(i, discordClient);
    } catch (e) {
      if (i.isAutocomplete()) return i.respond([]).catch(() => {});
      await replyError(i, e);
    }
  });

  client.on('error', e => console.error('[discord] client error:', e.message));
  client.on('warn', e => console.warn('[discord] warning:', e));
  client.on('shardError', e => console.error('[discord] shard error:', e.message));

  // Retry login with backoff on transient failures (network, Discord instability),
  // indefinitely so a blip in Discord/gateway connectivity self-heals without a
  // manual restart. Only a definitively invalid token stops the loop.
  (async () => {
    let attempt = 0;
    while (true) {
      try {
        await client.login(token);
        break; // success
      } catch (err) {
        attempt++;
        const isRateLimit = err.code === 429;
        const isNetwork = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(err.code) || err.message?.toLowerCase().includes('connection');
        const isToken = err.code === 401 || /invalid token/i.test(err.message);
        if (isToken) {
          console.error('[bot] login token is invalid — check DISCORD_BOT_TOKEN');
          return;
        }
        const delay = Math.min(10000 * Math.pow(1.5, attempt - 1), 60000) + (isRateLimit ? 5000 : 0);
        console.warn(`[bot] login attempt ${attempt} failed: ${err.message}; retry in ${Math.round(delay / 1000)}s`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  })().catch(() => {});

  return client;
}


async function handleAutocomplete(i) {
  if (!i.inGuild() || i.guildId !== GUILD_ID || !manage(i)) return i.respond([]);
  const s = storeFor();
  const focused = i.options.getFocused(true);
  const query = String(focused.value || '').toLowerCase();
  const t0 = Date.now();

  let values = [];
  if (focused.name === 'username' || focused.name === 'query') {
    values = s.getUsers().map(u => ({
      name: u.enabled === false ? `${u.username} (paused)` : u.username,
      value: u.username,
    }));
  } else if (focused.name === 'account') {
    values = s.getPublicAccounts().map(a => ({
      name: `${a.name} [${a.enabled ? 'enabled' : 'disabled'}]`,
      value: a.id,
    }));
  }
  if (!values.length && localFeatures?.autocomplete) values = await localFeatures.autocomplete(i, { store: s });

  const filtered = sanitizeChoices(values
    .filter(v => !query || v.name.toLowerCase().includes(query) || v.value.toLowerCase().includes(query)));

  const dt = Date.now() - t0;
  if (dt > 200) console.warn(`[autocomplete] slow(${dt}ms) cmd=${i.commandName} opt=${focused.name} q=${JSON.stringify(query.slice(0, 30))} items=${filtered.length}`);
  return i.respond(filtered).catch(e => { console.warn(`[autocomplete] respond failed for ${i.commandName}:`, e.message); return i.respond([]).catch(() => {}); });
}

async function handle(i, client) {
  if (!i.inGuild()) return i.reply({ content: `${I.no} Alicia Tracker commands are server-only.`, flags: MessageFlags.Ephemeral });
  if (i.guildId !== GUILD_ID) return i.reply({ content: `${I.no} Alicia Tracker is private to the configured server.`, flags: MessageFlags.Ephemeral });
  const store = storeFor();
  const tracker = trackerFor();
  const name = i.commandName;

  const managing = ['setup', 'track', 'cookie', 'notify', 'settings', 'poll', 'tracker', 'export', 'import'].includes(name);
  const localManaging = localFeatures?.managing?.includes(name) === true;
  if ((managing || localManaging) && !manage(i)) return i.reply({ content: `${I.no} You need the Manage Server permission.`, flags: MessageFlags.Ephemeral });

  if (localFeatures?.handleCommand) {
    const handled = await localFeatures.handleCommand(i, { client, store, tracker });
    if (handled) return handled;
  }

  if (name === 'setup') return i.reply({ content: `${I.ok} Alicia Tracker is ready for **${safeGuildName(i.guild)}**. Start with \`/notify channel\` and \`/track add\`.`, flags: MessageFlags.Ephemeral });
  if (name === 'help') return help(i);
  if (name === 'ping') {
    const sent = await i.reply({ content: `${I.clock} Measuring...`, fetchReply: true, flags: MessageFlags.Ephemeral });
    return i.editReply(`${I.ok} Bot **${Math.max(0, sent.createdTimestamp - i.createdTimestamp)}ms** ${I.dot} Gateway **${Math.max(0, i.client.ws.ping)}ms**`);
  }
  if (name === 'export') {
    const json = store.exportJson();
    const size = Buffer.byteLength(json);
    if (size > 10 * 1024 * 1024) return i.reply({ content: `${I.no} Backup is too large to attach (${(size / 1024 / 1024).toFixed(1)} MB).`, flags: MessageFlags.Ephemeral });
    return i.reply({ content: `${I.ok} Full backup attached. Keep it private — it includes cookies.`, files: [{ attachment: Buffer.from(json), name: 'alicia-tracker-export.json' }], flags: MessageFlags.Ephemeral });
  }
  if (name === 'import') {
    const file = i.options.getAttachment('file', true);
    if (!file || !file.name.endsWith('.json')) return i.reply({ content: `${I.no} Attach a JSON backup file.`, flags: MessageFlags.Ephemeral });
    if (file.size > 10 * 1024 * 1024) return i.reply({ content: `${I.no} Backup is too large (max 10 MB).`, flags: MessageFlags.Ephemeral });
    let text;
    try {
      const res = await fetch(file.url);
      text = await res.text();
    } catch {
      return i.reply({ content: `${I.no} Could not download the backup file.`, flags: MessageFlags.Ephemeral });
    }
    try {
      const state = store.importState(text);
      return i.reply({ content: `${I.ok} Backup restored: **${state.users.length}** users, **${state.accounts.length}** accounts, **${Object.keys(state.history || {}).length}** history groups.`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      return i.reply({ content: `${I.no} Import failed: ${e?.message || 'invalid backup'}`, flags: MessageFlags.Ephemeral });
    }
  }
  if (name === 'uptime') return i.reply(`${I.clock} Uptime: **${formatDuration(process.uptime() * 1000)}**`);
  if (name === 'about') return i.reply({ embeds: [new EmbedBuilder().setTitle('Alicia Tracker v2.5.7').setDescription('Resilient single-server Roblox presence tracker.').setColor(BRAND).addFields({ name: 'Servers', value: String(1), inline: true }, { name: 'Node', value: process.version, inline: true }, { name: 'Storage', value: 'Segmented per-user files', inline: true })] });
  if (name === 'status') return status(i, tracker, store);
  if (name === 'board') return board(i, tracker, store);
  if (name === 'together') return together(i, tracker, store);
  if (name === 'topgames') return topgames(i, store);
  if (name === 'track') return track(i, client, tracker, store);
  if (name === 'cookie') return cookie(i, store);
  if (name === 'notify') return notify(i, client, tracker, store);
  if (name === 'tracker') return trackerCmd(i, tracker, store);
  if (name === 'settings') return settings(i, tracker, store);
  if (name === 'poll') { await i.deferReply({ flags: MessageFlags.Ephemeral }); const ok = await tracker.pollOnce(); return i.editReply(ok ? `${I.ok} Poll complete.` : `${I.off} Poll skipped because another poll is already running.`); }
  if (name === 'stats') return stats(i, tracker, store);
  if (name === 'history') return history(i, store);
  if (name === 'activity') return activity(i, store);
  if (name === 'health') {
    const m = tracker.getMeta();
    const api = m.api || {};
    return i.reply({ embeds: [new EmbedBuilder().setTitle(`${I.dot} Health`).setColor(api.status === 'degraded' || m.lastError ? 0xff4d4d : BRAND).addFields(
      { name: 'Polling', value: m.polling ? 'active' : 'idle', inline: true },
      { name: 'Interval', value: `${m.intervalMs}ms`, inline: true },
      { name: 'Tracked', value: String(m.tracked), inline: true },
      { name: 'Polls', value: String(m.pollCount), inline: true },
      { name: 'Failures', value: String(m.failedPollCount), inline: true },
      { name: 'Backoff', value: m.backoffMs ? `${m.backoffMs}ms` : 'none', inline: true },
      { name: 'Last poll', value: when(m.lastPollAt), inline: true },
      { name: 'API status', value: `${api.status || 'healthy'}${api.consecutiveFailures ? ` (${api.consecutiveFailures} consecutive failures)` : ''}`, inline: true },
      { name: 'API last failure', value: api.lastFailure ? `${api.lastFailure.slice(0, 200)} @ ${when(new Date(api.lastFailureAt).toISOString())}` : 'none', inline: false },
      { name: 'Last error', value: m.lastError ? m.lastError.slice(0, 900) : 'none', inline: false },
    )], flags: MessageFlags.Ephemeral });
  }
}

function help(i) {
  return i.reply({ embeds: [new EmbedBuilder().setTitle('Alicia Tracker').setColor(BRAND).addFields(
    { name: 'Setup', value: '`/setup` · `/notify channel` · `/track add`' },
    { name: 'Tracking', value: '`/track add` · `/track remove` · `/track list` · `/track pause` · `/track resume` · `/track account` · `/track alerts` · `/track alerts-reset` · `/track usernotify` · `/track info` · `/track search`' },
    { name: 'Diagnostics', value: '`/tracker inspect` · `/tracker refresh`' },
    { name: 'Accounts', value: '`/cookie add` · `/cookie list` · `/cookie test` · `/cookie toggle` · `/cookie rename` · `/cookie replace` · `/cookie remove`' },
    { name: 'Notifications', value: '`/notify channel` · `/notify user-channel-clear` · `/notify test` · `/notify clear` · `/notify status`' },
    { name: 'Insights', value: '`/board view:all|ingame|online|offline|paused|issues` · `/together` · `/topgames` · `/status` · `/stats` · `/history` · `/activity` · `/health`' },
    { name: 'Settings', value: '`/settings` · `/ping`' },
    { name: 'Utility', value: '`/poll now` · `/ping` · `/uptime` · `/about`' },
  ).setFooter({ text: 'Sensitive and mutating commands require Manage Server.' })] });
}

async function status(i, t, s) {
  const u = i.options.getString('username', true).trim();
  if (!s.getUsers().some(x => x.username.toLowerCase() === u.toLowerCase())) return i.reply({ content: `${I.no} Not tracked.`, flags: MessageFlags.Ephemeral });
  await i.deferReply();
  await t.pollOnce();
  const snap = getSnapshot(t, u);
  if (!snap) return i.editReply(`${I.off} No status yet.`);
  return i.editReply({ embeds: [buildEmbed(snap, { serverInfo: storeFor().getServerInfo(), compactLinks: storeFor().getCompactLinks() })], components: buildComponents(snap) || [] });
}

async function board(i, t, s) {
  const users = s.getUsers();
  const view = i.options.getString('view') || 'all';
  if (!users.length) return i.reply({ content: `${I.off} No tracked users yet.`, flags: MessageFlags.Ephemeral });
  await i.deferReply();
  await t.pollOnce();
  const map = new Map(t.getSnapshot().map(x => [x.username.toLowerCase(), x]));
  const { rows, shown, total } = buildBoardView(users, map, view, s.getAccountMap());
  if (!rows.length) return i.editReply(`${I.off} No tracked users match **${view}**.`);
  const footer = [`${view} view · ${shown}/${total} shown`];
  const watch = s.getTiktokWatch();
  if (watch.length) footer.push(`TikTok: ${watch.map(h => `@${h}`).join(', ')}`);
  if (s.getQuiet()) footer.push('Quiet mode ON');
  const footerText = truncateDiscordText(footer.join(' · '));
  const descriptions = chunkDiscordLines(rows);
  const embeds = descriptions.map((description, index) => new EmbedBuilder()
    .setTitle(index === 0 ? `${I.dot} Status Board` : `${I.dot} Status Board (${index + 1}/${descriptions.length})`)
    .setColor(BRAND)
    .setDescription(description)
    .setFooter({ text: footerText }));
  return i.editReply({ embeds });
}

function findAccount(s, value) {
  const q = String(value || '').trim();
  if (!q) return null;
  const accounts = s.getAccounts();
  return s.getAccount(q) || accounts.find(a => a.id?.toLowerCase() === q.toLowerCase() || String(a.name || '').toLowerCase() === q.toLowerCase()) || null;
}

async function track(i, client, t, s) {
  const sub = i.options.getSubcommand();
  const u = String(i.options.getString('username') || '').trim();
  const query = String(i.options.getString('query') || '').trim();

  if (sub === 'add') {
    const aid = String(i.options.getString('account') || '').trim();
    const a = aid ? findAccount(s, aid) : null;
    if (aid && !a) return i.reply({ content: `${I.no} Account not found. Use the ID or label from \`/cookie list\`.`, flags: MessageFlags.Ephemeral });
    const r = s.addUser(u, a?.id || null);
    if (!r.added) return i.reply({ content: r.reason === 'limit' ? `${I.no} Tracker limit reached (${r.limit}).` : `${I.off} Already tracked.`, flags: MessageFlags.Ephemeral });
    t.pollOnce().catch(() => {});
    return i.reply({ content: `${I.ok} Tracking **${u}**${a ? ` with **${a.name}**` : ''}.`, flags: MessageFlags.Ephemeral });
  }
  if (sub === 'remove') { const r = s.removeUser(u); return i.reply({ content: r.removed ? `${I.ok} Removed **${u}**.` : `${I.off} Not tracked.`, flags: MessageFlags.Ephemeral }); }
  if (sub === 'list') {
    const users = s.getUsers();
    if (!users.length) return i.reply(`${I.off} No tracked users.`);
    const map = new Map(t.getSnapshot().map(x => [x.username.toLowerCase(), x]));
    const lines = users.map(x => `**${x.username}** — ${x.enabled === false ? 'paused' : statusLine(map.get(x.username.toLowerCase()))} — ${x.accountId ? 'cookie linked' : 'no cookie'}${x.tiktokHandle ? ` — tiktok @${x.tiktokHandle}` : ''}`);
    const watch = s.getTiktokWatch();
    if (watch.length) lines.push('', `${I.dot} Standalone TikTok: ${watch.map(h => `@${h}`).join(', ')}`);
    return i.reply({ embeds: [new EmbedBuilder().setTitle(`${I.dot} Watchlist`).setColor(BRAND).setDescription(lines.join('\n'))] });
  }
  if (sub === 'pause' || sub === 'resume') {
    const x = s.getUsers().find(x => x.username.toLowerCase() === u.toLowerCase());
    if (!x) return i.reply({ content: `${I.no} Not tracked.`, flags: MessageFlags.Ephemeral });
    s.updateUser(x.username, { enabled: sub === 'resume' });
    return i.reply({ content: `${I.ok} **${x.username}** ${sub === 'resume' ? 'resumed' : 'paused'}.`, flags: MessageFlags.Ephemeral });
  }
  if (sub === 'account') {
    const aid = String(i.options.getString('account', true)).trim();
    const x = s.getUsers().find(x => x.username.trim().toLowerCase() === u.toLowerCase());
    const a = findAccount(s, aid);
    if (!x) return i.reply({ content: `${I.no} Tracker not found. Run \`/track add username:${u}\` first.`, flags: MessageFlags.Ephemeral });
    if (!a) return i.reply({ content: `${I.no} Account not found. Use the ID or label shown by \`/cookie list\`.`, flags: MessageFlags.Ephemeral });
    s.updateUser(x.username, { accountId: a.id, enabled: true });
    t.pollOnce().catch(() => {});
    return i.reply({ content: `${I.ok} **${x.username}** now uses **${a.name}**.`, flags: MessageFlags.Ephemeral });
  }
  if (sub === 'usernotify') {
    const username = validateUsername(i.options.getString('username', true));
    const channel = i.options.getChannel('channel', true);
    if (!channel || channel.type !== ChannelType.GuildText) return i.reply({ content: `${I.no} Channel must be a text channel.`, flags: MessageFlags.Ephemeral });
    if (channel.guildId !== GUILD_ID) return i.reply({ content: `${I.no} That channel is not in the configured server.`, flags: MessageFlags.Ephemeral });
    const x = s.getUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!x) return i.reply({ content: `${I.no} Not tracked. Run \`/track add username:${username}\` first.`, flags: MessageFlags.Ephemeral });
    const defaultChannelId = s.getSettings().notifyChannelId;
    if (defaultChannelId && sameChannel(channel.id, defaultChannelId)) {
      return i.reply({ content: `${I.no} That is already the default alert channel.`, flags: MessageFlags.Ephemeral });
    }
    const accessible = await safeFetchChannel(client, channel.id);
    if (!accessible) return i.reply({ content: `${I.no} I cannot access or send messages to that channel.`, flags: MessageFlags.Ephemeral });
    s.setUserChannel(x.username, channel.id);
    return i.reply({ content: `${I.ok} **${x.username}** alerts will now go to <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
  }
  if (sub === 'usernotify-clear') {
    const username = validateUsername(i.options.getString('username', true));
    const x = s.getUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!x) return i.reply({ content: `${I.no} Not tracked.`, flags: MessageFlags.Ephemeral });
    if (!s.getUserChannel(x.username)) return i.reply({ content: `${I.off} **${x.username}** already uses the default alert channel.`, flags: MessageFlags.Ephemeral });
    s.setUserChannel(x.username, null);
    return i.reply({ content: `${I.ok} **${x.username}** will use the default alert channel again.`, flags: MessageFlags.Ephemeral });
  }
  if (sub === 'alerts') {
    const type = i.options.getString('type', true);
    const enabled = i.options.getBoolean('enabled', true);
    const x = s.getUsers().find(x => x.username.toLowerCase() === u.toLowerCase());
    if (!x) return i.reply({ content: `${I.no} Not tracked.`, flags: MessageFlags.Ephemeral });
    s.updateUser(x.username, { notifications: { [type]: enabled } });
    return i.reply({ content: `${I.ok} ${type} alerts are ${enabled ? 'enabled' : 'disabled'} for **${x.username}**.`, flags: MessageFlags.Ephemeral });
  }
  if (sub === 'alerts-reset') {
    const type = i.options.getString('type');
    const x = s.getUsers().find(x => x.username.toLowerCase() === u.toLowerCase());
    if (!x) return i.reply({ content: `${I.no} Not tracked.`, flags: MessageFlags.Ephemeral });
    s.resetUserNotifications(x.username, type);
    return i.reply({ content: `${I.ok} ${type ? `${notifLabel(type)} alerts` : 'All alerts'} for **${x.username}** now follow the server default.`, flags: MessageFlags.Ephemeral });
  }
  if (sub === 'tiktok') {
    const handle = String(i.options.getString('handle') || '').replace(/^@/, '').trim().toLowerCase();
    if (!/^[a-z0-9_]{2,24}$/.test(handle)) return i.reply({ content: `${I.no} Invalid TikTok handle: use letters/numbers/_ only, 2-24 chars, no @.`, flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const linkedUsername = String(i.options.getString('username') || '').trim();
    const statusHint = await tiktok.getLiveStatus(handle).catch(() => null);
    const notFoundHint = statusHint && !statusHint.roomId && statusHint.nickname === handle ? '\nNote: TikTok reports this handle as not found / never-lived — I will still alert the moment it goes live.' : '';
    if (linkedUsername) {
      const x = s.getUsers().find(x => x.username.toLowerCase() === linkedUsername.toLowerCase());
      if (!x) return i.editReply(`${I.no} Not tracked.`);
      tiktokState.delete(x.tiktokHandle);
      s.updateUser(x.username, { tiktokHandle: handle });
      startTiktokPoller(s);
      return i.editReply(`${I.ok} TikTok handle **@${handle}** linked to **${x.username}** (experimental LIVE tracking). Use \`/settings tiktok on\` to enable.${notFoundHint}`);
    }
    s.addTiktokWatch(handle);
    tiktokState.delete(handle);
    startTiktokPoller(s);
    return i.editReply(`${I.ok} Tracking **@${handle}** standalone (experimental LIVE tracking). Use \`/settings tiktok on\` to enable.${notFoundHint}`);
  }
  if (sub === 'tiktok-remove') {
    const handle = String(i.options.getString('handle') || '').replace(/^@/, '').trim().toLowerCase();
    const linkedUser = s.getUsers().find(x => x.tiktokHandle === handle);
    if (linkedUser) s.updateUser(linkedUser.username, { tiktokHandle: null });
    s.removeTiktokWatch(handle);
    tiktokState.delete(handle);
    return i.reply({ content: `${I.ok} Stopped tracking **@${handle}**.`, flags: MessageFlags.Ephemeral });
  }
  if (sub === 'info') {
    const x = s.getUsers().find(x => x.username.toLowerCase() === u.toLowerCase());
    if (!x) return i.reply({ content: `${I.no} Not tracked.`, flags: MessageFlags.Ephemeral });
    const snap = getSnapshot(t, u);
    return i.reply({ embeds: [new EmbedBuilder().setTitle(`Tracker — ${x.username}`).setColor(BRAND).addFields(
      { name: 'Status', value: statusLine(snap), inline: true },
      { name: 'Enabled', value: x.enabled === false ? 'no' : 'yes', inline: true },
      { name: 'Cookie', value: x.accountId ? (s.getAccount(x.accountId)?.name || 'missing') : 'none', inline: true },
      { name: 'Alerts', value: effectiveAlertText(s, x.username) },
    )] });
  }
  if (sub === 'now') {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await t.pollOnce();
    const snap = getSnapshot(t, u);
    return i.editReply(snap ? { embeds: [buildEmbed(snap, { serverInfo: storeFor().getServerInfo(), compactLinks: storeFor().getCompactLinks() })], components: buildComponents(snap) || [] } : `${I.off} No status yet.`);
  }
  if (sub === 'search') {
    const q = query.toLowerCase();
    const users = s.searchUsers(q, 20);
    return i.reply({ content: users.length ? users.map(x => `• **${x.username}**`).join('\n') : `${I.off} No tracked users matched.`, flags: MessageFlags.Ephemeral });
  }
}

async function cookie(i, s) {
  const sub = i.options.getSubcommand();
  if (sub === 'add' || sub === 'replace') {
    const c = i.options.getString('cookie', true);
    const id = sub === 'replace' ? i.options.getString('account', true) : null;
    let a = id ? findAccount(s, id) : null;
    if (id && !a) return i.reply({ content: `${I.no} Account not found.`, flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const auth = await roblox.retryable(() => roblox.checkAuth(c), 'cookie verification');
      const refreshed = roblox.takeRefreshedCookie(c);
      const verifiedCookie = refreshed || c;
      if (a) {
        s.updateAccount(a.id, { cookie: verifiedCookie, lastAuth: auth, lastError: null });
      } else {
        a = s.addAccount({ name: i.options.getString('label', true), cookie: verifiedCookie });
        s.updateAccount(a.id, { lastAuth: auth, lastError: null });
      }
      return i.editReply(`${I.ok} **${a.name}** verified as **${auth.name}**.`);
    } catch (e) {
      if (a) s.updateAccount(a.id, { lastError: e.message });
      return i.editReply(`${I.no} Verification failed: ${e.message}`);
    }
  }
  if (sub === 'list') {
    const accounts = s.getPublicAccounts();
    const text = accounts.length ? accounts.map(x => `**${x.name}** · ID \`${x.id}\` · ${x.enabled ? 'enabled' : 'disabled'} · ${x.cookieMasked}`).join('\n') : `${I.off} No accounts.`;
    return i.reply({ content: text, flags: MessageFlags.Ephemeral });
  }
  const id = i.options.getString('account', true);
  const a = findAccount(s, id);
  if (!a) return i.reply({ content: `${I.no} Account not found. Use the ID or label from \`/cookie list\`.`, flags: MessageFlags.Ephemeral });
  if (sub === 'remove') { s.removeAccount(a.id); return i.reply({ content: `${I.ok} Removed **${a.name}**.`, flags: MessageFlags.Ephemeral }); }
  if (sub === 'toggle') { const enabled = i.options.getBoolean('enabled', true); s.updateAccount(a.id, { enabled }); return i.reply({ content: `${I.ok} **${a.name}** ${enabled ? 'enabled' : 'disabled'}.`, flags: MessageFlags.Ephemeral }); }
  if (sub === 'rename') { s.updateAccount(a.id, { name: i.options.getString('name', true) }); return i.reply({ content: `${I.ok} Renamed account.`, flags: MessageFlags.Ephemeral }); }
  if (sub === 'test') {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try { const auth = await roblox.checkAuth(a.cookie); s.updateAccount(a.id, { lastAuth: auth, lastError: null }); return i.editReply(`${I.ok} Valid — **${auth.name}**.`); }
    catch (e) { s.updateAccount(a.id, { lastError: e.message }); return i.editReply(`${I.no} ${e.message}`); }
  }
}

async function notify(i, client, t, s) {
  const sub = i.options.getSubcommand();
  if (sub === 'channel') { const c = i.options.getChannel('channel', true); s.setSettings({ notifyChannelId: c.id }); bindSender(client); return i.reply({ content: `${I.ok} Alerts will post in <#${c.id}>.`, flags: MessageFlags.Ephemeral }); }
  if (sub === 'user-channel-clear') {
    const username = validateUsername(i.options.getString('username', true));
    const current = s.getUserChannel(username);
    if (!current) return i.reply({ content: `${I.off} **${username}** has no dedicated alert channel.`, flags: MessageFlags.Ephemeral });
    s.setUserChannel(username, null);
    return i.reply({ content: `${I.ok} **${username}** will use the default alert channel.`, flags: MessageFlags.Ephemeral });
  }
  if (sub === 'clear') { s.setSettings({ notifyChannelId: null }); return i.reply({ content: `${I.ok} Alert channel cleared.`, flags: MessageFlags.Ephemeral }); }
  if (sub === 'status') {
    const id = s.getSettings().notifyChannelId;
    const userChannels = s.getUserChannels();
    const ch = id ? await safeFetchChannel(client, id) : null;
    const count = Object.keys(userChannels).length;
    const base = id
      ? (ch ? `${I.ok} Default alert channel: <#${id}>` : `${I.no} Default alert channel is unavailable. Choose another with \`/notify channel\`.`)
      : `${I.off} No default alert channel configured.`;
    const suffix = count ? `\n${I.dot} ${count} user(s) have dedicated alert channels.` : '';
    return i.reply({ content: base + suffix, flags: MessageFlags.Ephemeral });
  }
  if (sub === 'test') {
    const username = String(i.options.getString('username') || '').trim().toLowerCase();
    if (username) return testNotifyUser(i, client, t, s, username);
    const id = s.getSettings().notifyChannelId; const ch = await safeFetchChannel(client, id); if (!ch) return i.reply({ content: `${I.no} Configure an accessible alert channel first.`, flags: MessageFlags.Ephemeral }); try { await ch.send({ content: `${I.ok} Alicia Tracker test notification.` }); return i.reply({ content: `${I.ok} Test sent.`, flags: MessageFlags.Ephemeral }); } catch (e) { return i.reply({ content: `${I.no} Could not send: ${e.message}`, flags: MessageFlags.Ephemeral }); }
  }
}

async function testNotifyUser(i, client, t, s, username) {
  const x = s.getUsers().find(u => u.username.toLowerCase() === username);
  if (!x) return i.reply({ content: `${I.no} Not tracked. Run \`/track add\` first.`, flags: MessageFlags.Ephemeral });
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try { await t.pollOnce(); } catch (e) { /* keep whatever snapshot we have */ }
  const snap = getSnapshot(t, x.username);
  if (!snap) return i.editReply(`${I.no} No status yet for **${x.username}**.`);
  const target = s.getUserChannel(x.username.toLowerCase()) || s.getSettings().notifyChannelId;
  if (!target) return i.editReply(`${I.no} No alert channel configured for **${x.username}**.`);
  const ch = await safeFetchChannel(client, target);
  if (!ch) return i.editReply(`${I.no} Alert channel <#${target}> is unavailable.`);
  await queueChannelSend(target, async () => {
    await ch.send({ embeds: [buildEmbed({ ...snap, updatedAt: new Date().toISOString() }, { test: true, serverInfo: s.getServerInfo(), compactLinks: s.getCompactLinks() })], components: buildComponents(snap) || [] });
  });
  return i.editReply(`${I.ok} Test alert for **${snap.username}** sent to <#${target}>.`);
}

function settings(i, t, s) {
  const interval = i.options.getInteger('interval');
  const alertType = i.options.getString('alert_type');
  const alertValue = i.options.getString('alert_value');
  const gameOnly = i.options.getBoolean('game_only');
  const serverInfo = i.options.getBoolean('server_info');
  const allyPing = i.options.getBoolean('ally_ping');
  const tiktok = i.options.getBoolean('tiktok');
  const tiktokChannel = i.options.getChannel('tiktok_channel');
  const quiet = i.options.getBoolean('quiet');
  const quietMinutes = i.options.getInteger('quiet_minutes');
  const compactLinks = i.options.getBoolean('compact_links');

  if (alertValue && !alertType) return i.reply({ content: `${I.no} Choose an alert type before setting its value.`, flags: MessageFlags.Ephemeral });
  if (alertType && !alertValue) return i.reply({ content: `${I.no} Choose On or Off for the selected alert type.`, flags: MessageFlags.Ephemeral });
  if (quietMinutes != null && quiet !== true) return i.reply({ content: `${I.no} quiet_minutes requires quiet:True.`, flags: MessageFlags.Ephemeral });

  const changes = [];
  if (interval != null) {
    s.setSettings({ intervalMs: interval });
    t.setIntervalMs(interval);
    changes.push(`interval ${interval}ms`);
  }
  if (alertType && alertValue) {
    const current = s.getSettings().notifications || {};
    s.setSettings({ notifications: { ...current, [alertType]: alertValue === 'on' } });
    changes.push(`${notifLabel(alertType)} alerts ${alertValue}`);
  }
  if (gameOnly != null) { s.setGameOnly(gameOnly); changes.push(`game-only ${gameOnly ? 'on' : 'off'}`); }
  if (serverInfo != null) { s.setServerInfo(serverInfo); changes.push(`server info ${serverInfo ? 'on' : 'off'}`); }
  if (allyPing != null) { s.setAllyPing(allyPing); changes.push(`ally ping ${allyPing ? 'on' : 'off'}`); }
  if (tiktok != null) {
    const wasEnabled = s.getTiktokLive();
    s.setTiktokLive(tiktok);
    if (tiktok && !wasEnabled) startTiktokPoller(s);
    if (!tiktok && wasEnabled) stopTiktokPoller();
    changes.push(`tiktok ${tiktok ? 'on' : 'off'}`);
  }
  if (tiktokChannel) {
    s.setTiktokChannel(tiktokChannel.id);
    changes.push(`tiktok channel <#${tiktokChannel.id}>`);
  }
  if (quiet != null) {
    s.setQuiet(quiet, quiet ? quietMinutes || 0 : 0);
    changes.push(`quiet ${quiet ? `on${quietMinutes ? ` for ${quietMinutes}m` : ''}` : 'off'}`);
  }
  if (compactLinks != null) { s.setCompactLinks(compactLinks); changes.push(`compact links ${compactLinks ? 'on' : 'off'}`); }

  if (!changes.length) return settingsOverview(i, t, s);
  return i.reply({ content: `${I.ok} Updated ${changes.join(', ')}.\n\n${settingsText(t, s)}`, flags: MessageFlags.Ephemeral });
}

function settingsText(t, s) {
  const x = s.getSettings();
  const m = t.getMeta();
  const tt = s.getTiktokLive() ? s.getTiktokPoint() : 0;
  const ttHandles = s.getUsers().filter(u => u.tiktokHandle).length + (s.getTiktokWatch() || []).length;
  const alertTypes = Object.entries(x.notifications || {}).map(([key, value]) => `${notifLabel(key)} ${value === false ? 'off' : 'on'}`).join(', ');
  return `${I.gear} Interval: **${x.intervalMs}ms**\n${I.dot} Alerts: ${x.notifyChannelId ? `<#${x.notifyChannelId}>` : 'not configured'}\n${I.dot} Server alerts: ${alertTypes}\n${I.dot} Game-only: **${s.getGameOnly() ? 'on' : 'off'}**\n${I.dot} Server info: **${s.getServerInfo() ? 'on' : 'off'}**\n${I.dot} Ally ping: **${s.getAllyPing() ? 'on' : 'off'}**\n${I.dot} TikTok LIVE: **${s.getTiktokLive() ? 'on' : 'off'}**${tt ? ` every ${Math.round(tt / 1000)}s` : ''}${ttHandles ? `, ${ttHandles} linked` : ''}\n${I.dot} TikTok channel: ${s.getTiktokChannel() ? `<#${s.getTiktokChannel()}>` : 'same as Alerts'}\n${I.dot} Quiet mode: **${s.getQuiet() ? 'on' : 'off'}**\n${I.dot} Compact links: **${s.getCompactLinks() ? 'on' : 'off'}**\n${I.dot} Failures: **${m.failedPollCount}**`;
}

function settingsOverview(i, t, s) {
  return i.reply({ content: `${settingsText(t, s)}\n\nUse one \`/settings\` command with any option, for example \`/settings interval:30000\` or \`/settings quiet:True\`.`, flags: MessageFlags.Ephemeral });
}

function notifLabel(type) {
  return { online: 'Online', offline: 'Offline', gameJoin: 'Game Join', gameChange: 'Game Change', gameLeave: 'Game Leave' }[type] || type;
}

function effectiveAlertText(s, username) {
  return ['online', 'offline', 'gameJoin', 'gameChange', 'gameLeave']
    .map(type => {
      const policy = s.getNotificationPolicy(username, type);
      return `${notifLabel(type)}: ${policy.enabled ? 'on' : 'off'} (${policy.source === 'user' ? 'user override' : 'server default'})`;
    })
    .join('\n');
}

function trackerCmd(i, t, s) {
  const sub = i.options.getSubcommand();
  const username = i.options.getString('username', true).trim();
  const x = s.getUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!x) return i.reply({ content: `${I.no} Not tracked.`, flags: MessageFlags.Ephemeral });
  if (sub === 'inspect') return inspectTracker(i, t, s, x);
  if (sub === 'refresh') return refreshTracker(i, t, s, x);
}

function sessionDurationLabel(ms) {
  if (ms == null || ms < 0) return 'Unknown';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h && `${h}h`, m && `${m}m`, `${sec}s`].filter(Boolean).join(' ');
}

function serverTypeLabel(t) {
  if (t === 'public') return 'Public';
  if (t === 'private') return 'Private';
  if (t === 'joins-off') return 'Unknown (joins off)';
  return 'N/A';
}

function inspectTracker(i, t, s, x) {
  const snap = getSnapshot(t, x.username);
  if (!snap) return i.reply({ content: `${I.off} No status yet for **${x.username}**.`, flags: MessageFlags.Ephemeral });
  const sessionDuration = snap.sessionDurationMs != null ? sessionDurationLabel(snap.sessionDurationMs) : 'N/A';
  const userChannelId = s.getUserChannel(x.username);
  return i.reply({ embeds: [new EmbedBuilder()
    .setTitle(`Inspect — ${x.username}`)
    .setColor(BRAND)
    .setThumbnail(snap.avatarUrl || null)
    .addFields(
      { name: 'Status', value: statusLine(snap), inline: true },
      { name: 'Game', value: snap.gameName || 'None', inline: true },
      { name: 'Place ID', value: snap.placeId ? String(snap.placeId) : 'N/A', inline: true },
      { name: 'Server Type', value: serverTypeLabel(snap.serverType), inline: true },
      { name: 'Session Duration', value: sessionDuration, inline: true },
      { name: 'Last Update', value: snap.updatedAt ? when(snap.updatedAt) : 'Never', inline: true },
      { name: 'Linked Account', value: x.accountId ? (s.getAccount(x.accountId)?.name || 'Missing') : 'None', inline: true },
      { name: 'Alert Channel', value: userChannelId ? `<#${userChannelId}>` : `Default (<#${s.getSettings().notifyChannelId || 'none'}>)`, inline: true },
      { name: 'Alerts', value: effectiveAlertText(s, x.username) },
    )] });
}

async function refreshTracker(i, t, s, x) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try { await t.pollOnce(); } catch (e) { /* proceed with whatever we have */ }
  const snap = getSnapshot(t, x.username);
  if (!snap) return i.editReply(`${I.off} No status yet for **${x.username}**.`);
  const sessionDuration = snap.sessionDurationMs != null ? sessionDurationLabel(snap.sessionDurationMs) : 'N/A';
  return i.editReply({ embeds: [new EmbedBuilder()
    .setTitle(`Refresh — ${x.username}`)
    .setColor(BRAND)
    .setThumbnail(snap.avatarUrl || null)
    .addFields(
      { name: 'Status', value: statusLine(snap), inline: true },
      { name: 'Game', value: snap.gameName || 'None', inline: true },
      { name: 'Place ID', value: snap.placeId ? String(snap.placeId) : 'N/A', inline: true },
      { name: 'Server Type', value: serverTypeLabel(snap.serverType), inline: true },
      { name: 'Session Duration', value: sessionDuration, inline: true },
      { name: 'Last Update', value: snap.updatedAt ? when(snap.updatedAt) : 'Never', inline: true },
      { name: 'Linked Account', value: x.accountId ? (s.getAccount(x.accountId)?.name || 'Missing') : 'None', inline: true },
    )] });
}

function stats(i, t, s) {
  const u = i.options.getString('username', true);
  const x = s.getUsers().find(x => x.username.toLowerCase() === u.toLowerCase());
  if (!x) return i.reply({ content: `${I.no} Not tracked.`, flags: MessageFlags.Ephemeral });
  const e = s.getHistory(x.username, 0), snap = getSnapshot(t, u);
  const onlineEvents = e.filter(v => v.eventType === 'online').length;
  const gameEvents = e.filter(v => v.eventType === 'gameJoin' || v.eventType === 'gameChange' || v.eventType === 'gameLeave').length;
  return i.reply({ embeds: [new EmbedBuilder().setTitle(`Stats — ${x.username}`).setColor(BRAND).addFields(
    { name: 'Current', value: statusLine(snap), inline: true },
    { name: 'Events', value: String(e.length), inline: true },
    { name: 'Online events', value: String(onlineEvents), inline: true },
    { name: 'Game events', value: String(gameEvents), inline: true },
    { name: 'Account', value: x.accountId ? (s.getAccount(x.accountId)?.name || 'missing') : 'none', inline: true },
    { name: 'Tracking', value: x.enabled === false ? 'paused' : 'active', inline: true },
  )] });
}
function history(i, s) {
  const u = i.options.getString('username', true), limit = i.options.getInteger('limit') || 10;
  const x = s.getUsers().find(x => x.username.toLowerCase() === u.toLowerCase());
  if (!x) return i.reply({ content: `${I.no} Not tracked.`, flags: MessageFlags.Ephemeral });
  const e = s.getHistory(x.username, limit);
  return i.reply({ embeds: [new EmbedBuilder().setTitle(`History — ${x.username}`).setColor(BRAND).setDescription(e.length ? e.map(v => `${when(v.at)} ${I.arrow} **${v.eventType || 'status'}** — ${v.status || 'unknown'}${v.gameName ? ` — ${v.gameName}` : ''}`).join('\n') : 'No history yet.')] });
}
function activity(i, s) {
  const limit = i.options.getInteger('limit') || 10, all = [];
  for (const u of s.getUsers()) for (const e of s.getHistory(u.username, 50)) all.push({ username: u.username, ...e });
  all.sort((a, b) => new Date(b.at) - new Date(a.at));
  return i.reply({ embeds: [new EmbedBuilder().setTitle(`${I.clock} Activity`).setColor(BRAND).setDescription(all.slice(0, limit).map(e => `${when(e.at)} ${I.arrow} **${e.username}** — ${e.eventType || 'status'} — ${e.status || 'unknown'}`).join('\n') || 'No activity yet.')] });
}

// Surprise #1: `/together` — group tracked users by the exact game+server they
// are currently in. Highlights anyone playing in the same instance.
async function together(i, t, s) {
  await i.deferReply();
  const snap = t.getSnapshot();
  const groups = groupInGame(snap);
  if (!groups.length) return i.editReply(`${I.off} Nobody is in a game right now.`);
  let total = 0;
  const lines = groups.map((g, idx) => {
    total += g.players.length;
    const members = g.players.length > 1 ? ` — **${g.players.length} players**` : '';
    const region = g.serverRegion ? ` (${g.serverRegion})` : '';
    const links = g.players.map(p => `> ${p}`).join('\n');
    return `${idx === 0 ? I.game : I.dot} **${g.gameName}**${members}${region}\n${links}`;
  });
  return i.editReply({ embeds: [new EmbedBuilder().setTitle(`${I.game} Together`).setColor(BRAND).setDescription(lines.join('\n')).setFooter({ text: `${total} tracked user${total === 1 ? '' : 's'} in-game right now` })] });
}

// Surprise #2: `/topgames <username>` — favorite games by total playtime from
// recent history of a tracked user.
function topgames(i, s) {
  const u = i.options.getString('username', true).trim();
  const x = s.getUsers().find(uu => uu.username.toLowerCase() === u.toLowerCase());
  if (!x) return i.reply({ content: `${I.no} Not tracked.`, flags: MessageFlags.Ephemeral });
  const historyRows = s.getHistory(x.username, 0);
  const rows = topGames(historyRows, 8);
  if (!rows.length) return i.reply({ content: `${I.off} No playtime history yet for **${x.username}**.`, flags: MessageFlags.Ephemeral });
  const lines = rows.map((r, idx) => `**#${idx + 1}** ${r.game} — \`${r.duration}\``);
  return i.reply({ embeds: [new EmbedBuilder().setTitle(`${I.game} Top Games — ${x.username}`).setColor(BRAND).setDescription(lines.join('\n'))] });
}

module.exports = {
  start,
  attachHealthReporter(fn) {
    return fn(() => {
      if (!tracker) return { ready: initialized };
      try {
        const m = tracker.getMeta();
        return { ...m, ready: initialized, degraded: roblox.isDegraded() };
      } catch { return { ready: initialized }; }
    });
  },
};
