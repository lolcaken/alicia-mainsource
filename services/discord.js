const COLORS = { Offline: 0x5b6270, Online: 0xffb020, 'In Game': 0x34d399, 'In Studio': 0x7c5cff };
const I = { game: '\u25C6', off: '\u25CB' };

function serverTypeLabel(t) {
  if (t === 'public') return 'Public';
  if (t === 'private') return 'Private';
  if (t === 'joins-off') return 'Unknown (joins off)';
  return 'Unknown';
}

function formatSession(ms) {
  if (ms == null || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h && `${h}h`, m && `${m}m`, `${sec}s`].filter(Boolean).join(' ');
}

function formatUptime(ms) {
  if (ms == null || ms < 0) return 'Unknown';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '<1m';
}

function buildEmbed(status, { test = false, serverInfo = false, compactLinks = false } = {}) {
  const name = status.displayName ? `${status.displayName} (@${status.username})` : status.username;
  let title;
  let description;
  let color;
  if (status.eventType === 'gameLeave') {
    title = 'Game Left';
    const game = status.gameName || 'a game';
    const duration = formatSession(status.sessionDurationMs);
    const lines = [`**${name}** left **${game}**`];
    if (duration) lines.push(`Session: ${duration}`);
    if (status.serverType === 'public') lines.push(`Server: ${serverTypeLabel(status.serverType)}`);
    if (serverInfo && status.serverUptimeMs != null) lines.push(`Uptime: ${formatUptime(status.serverUptimeMs)}`);
    if (serverInfo && status.serverRegion) lines.push(`Region: ${status.serverRegion}`);
    if (serverInfo && status.serverPlayers && status.serverPlayers.playing != null) lines.push(`Players: ${status.serverPlayers.playing}${status.serverPlayers.maxPlayers != null ? `/${status.serverPlayers.maxPlayers}` : ''}`);
    description = lines.join('\n');
    color = 0x5b6270;
  } else if (status.inGame) {
    title = `Now playing ${status.gameName || 'a game'}`;
    const lines = [];
  if (status.serverType === 'public') lines.push(`Server: ${serverTypeLabel(status.serverType)}`);
    if (serverInfo && status.serverUptimeMs != null) {
      lines.push(`Uptime: ${formatUptime(status.serverUptimeMs)}`);
    }
    if (serverInfo && status.serverRegion) {
      lines.push(`Region: ${status.serverRegion}`);
    }
    if (serverInfo && status.serverPlayers && status.serverPlayers.playing != null) {
      lines.push(`Players: ${status.serverPlayers.playing}${status.serverPlayers.maxPlayers != null ? `/${status.serverPlayers.maxPlayers}` : ''}`);
    }
    description = lines.join('\n');
  } else if (status.status === 'Online') {
    title = 'Online on Roblox';
  } else if (status.status === 'In Studio') {
    title = 'In Roblox Studio';
  } else {
    title = 'Went offline';
  }
  if (test) title = `[TEST] ${title}`;

  const embed = {
    author: { name, icon_url: status.avatarUrl || undefined, url: status.userId ? `https://www.roblox.com/users/${status.userId}/profile` : undefined },
    title,
    color: color ?? (test ? 0x7c5cff : COLORS[status.status] ?? 0x5b6270),
    thumbnail: status.avatarUrl ? { url: status.avatarUrl } : undefined,
    footer: { text: test ? 'Alicia Tracker · Test Notification' : 'Alicia Tracker' },
    timestamp: status.updatedAt || new Date().toISOString(),
  };
  if (description) embed.description = description;

  if (status.inGame && status.robloxDeepLink) {
    embed.fields = [{ name: 'Direct Roblox app link', value: `\`${status.robloxDeepLink}\`` }];
  }
  if (compactLinks && status.userId) {
    const links = [`[Profile](https://www.roblox.com/users/${status.userId}/profile)`];
    if (status.inGame && status.joinUrl) links.push(`[Join](${status.joinUrl})`);
    if (status.inGame && status.gameUrl) links.push(`[Game](${status.gameUrl})`);
    if (links.length > 1) embed.description = [description, links.join(' · ')].filter(Boolean).join('\n');
  }
  const joinPlaceId = status.gameUrl ? null : status.placeId;
  if (status.gameUrl) embed.url = status.gameUrl;
  else if (status.inGame && joinPlaceId) embed.url = `https://www.roblox.com/games/${joinPlaceId}`;
  return embed;
}

function buildComponents(status) {
  if (!status.inGame) return undefined;
  const url = status.joinUrl || status.gameUrl;
  if (!url) return undefined;
  return [{ type: 1, components: [{ type: 2, style: 5, label: status.joinUrl ? 'Join Server' : 'View Game', url }] }];
}

async function notify(status, opts = {}) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) { if (opts.test) throw new Error('DISCORD_WEBHOOK_URL is not set'); return; }
  const body = { username: 'Alicia Tracker', embeds: [buildEmbed(status, opts)] };
  const components = buildComponents(status);
  if (components) body.components = components;
  let url = webhookUrl;
  if (body.components) url += (webhookUrl.includes('?') ? '&' : '?') + 'with_components=true';
  try {
    // webhook calls can hang forever; apply a 15s timeout (matches Roblox API style).
    const WEBHOOK_TIMEOUT_MS = Math.max(5000, Number(process.env.DISCORD_WEBHOOK_TIMEOUT_MS) || 15000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!res.ok) throw new Error(`webhook failed ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  } catch (err) {
    if (opts.test) throw err;
    console.error('[discord]', err.message);
  }
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/([\\`*_[\]<>#|~-])/g, '\\$1');
}

function buildBoardView(users, snapshotMap = new Map(), view = 'all', accountMap = new Map()) {
  const inGame = [];
  const idle = [];
  let shown = 0;
  for (const user of users) {
    const key = String(user.username || '').toLowerCase();
    const status = snapshotMap.get(key);
    const account = user.accountId ? accountMap.get(user.accountId) : null;
    const paused = user.enabled === false;
    const issue = !status || !status.resolved || !!status.error || !!account?.lastError;
    const matches = view === 'all'
      || (view === 'paused' && paused)
      || (view === 'issues' && issue)
      || (view === 'ingame' && !paused && status?.inGame)
      || (view === 'online' && !paused && status?.resolved && !status.inGame && status.status === 'Online')
      || (view === 'offline' && !paused && status?.resolved && !status.inGame && status.status !== 'Online');
    if (!matches) continue;
    shown++;
    const name = escapeMarkdown(user.username);
    if (paused) {
      idle.push(`**${name}** — paused`);
    } else if (!status || !status.resolved) {
      idle.push(`**${name}** — × ${escapeMarkdown(status?.error || 'no snapshot')}`);
    } else if (status.inGame) {
      const type = status.serverType === 'public' ? ` (${serverTypeLabel(status.serverType)})` : '';
      const join = status.joinUrl ? ` — [join](${status.joinUrl})` : status.gameUrl ? ` — [game](${status.gameUrl})` : '';
      inGame.push(`**${name}** — ${I.game} ${escapeMarkdown(status.gameName || 'in game')}${type}${join}`);
    } else {
      idle.push(`**${name}** — ${I.off} ${escapeMarkdown(status.status || 'offline')}`);
    }
  }
  return { rows: [...inGame, ...idle], inGame: inGame.length, idle: idle.length, shown, total: users.length };
}

function buildBoardLines(users, snapshotMap = new Map()) {
  return buildBoardView(users, snapshotMap, 'all');
}

function chunkDiscordLines(lines, maxLength = 3800, maxRowLength = 300) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const raw of lines || []) {
    const row = String(raw || '').slice(0, maxRowLength);
    if (row.length > maxLength) {
      if (current.length) chunks.push(current.join('\n'));
      current = [];
      length = 0;
      for (let offset = 0; offset < row.length; offset += maxLength) chunks.push(row.slice(offset, offset + maxLength));
      continue;
    }
    const added = current.length ? row.length + 1 : row.length;
    if (current.length && length + added > maxLength) {
      chunks.push(current.join('\n'));
      current = [row];
      length = row.length;
    } else {
      current.push(row);
      length += added;
    }
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

function truncateDiscordText(value, maxLength = 2000) {
  const text = String(value || '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

// Pure autocomplete choice sanitizer: ensures Discord's strict choice limits
// (max 25 items, name & value 1-100 chars, no empty/newlines in name) are
// satisfied so i.respond() never throws a validation error.
function sanitizeChoices(values) {
  const out = [];
  for (const v of values || []) {
    if (out.length >= 25) break;
    const name = String(v?.name ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100);
    const value = String(v?.value ?? '').trim().slice(0, 100);
    if (!name || !value) continue;
    out.push({ name, value });
  }
  return out;
}

// Pure helper: groups currently in-game users by game and server instance.
// Returns an array of groups: { gameName, placeId, serverType, serverRegion, players: [name...] }.
function groupInGame(snapshots = []) {
  const groups = new Map();
  for (const s of snapshots) {
    if (!s || !s.inGame) continue;
    const key = `${s.placeId || '0'}:${s.gameId || 'none'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        gameName: s.gameName || 'Unknown Game',
        placeId: s.placeId,
        gameId: s.gameId,
        serverType: s.serverType,
        serverRegion: s.serverRegion,
        players: [],
      });
    }
    groups.get(key).players.push(s.displayName || s.username);
  }
  return [...groups.values()];
}

// Pure helper: summarizes game play time from a user's recent history entries.
// Reconstructs contiguous play sessions from chronological events.
function topGames(history = [], limit = 5) {
  // history is newest-first from store; reverse to chronological
  const chronological = [...history].reverse();
  const totals = new Map(); // gameName -> totalMs
  let current = null; // { gameName, startedAt }

  for (const e of chronological) {
    const at = new Date(e.at).getTime();
    if (isNaN(at)) continue;
    const inGame = e.inGame || ['gameJoin', 'gameChange'].includes(e.eventType);
    const game = e.gameName || (e.status && e.status !== 'In Game' && e.status !== 'Online' && e.status !== 'Offline' ? e.status : null);

    if (inGame && game) {
      if (current && current.gameName === game) {
        // continue session
      } else {
        if (current) {
          const dur = Math.max(0, at - current.startedAt);
          totals.set(current.gameName, (totals.get(current.gameName) || 0) + dur);
        }
        current = { gameName: game, startedAt: at };
      }
    } else if (current) {
      const dur = Math.max(0, at - current.startedAt);
      totals.set(current.gameName, (totals.get(current.gameName) || 0) + dur);
      current = null;
    }
  }
  // Cap at 24h per session to prevent unclosed historic entries from skewing
  const rows = [...totals.entries()]
    .map(([game, ms]) => ({ game, ms, duration: formatSession(Math.min(ms, 86400000 * 7)) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);
  return rows;
}

module.exports = { notify, buildEmbed, buildComponents, buildBoardLines, buildBoardView, chunkDiscordLines, truncateDiscordText, escapeMarkdown, sanitizeChoices, groupInGame, topGames };
