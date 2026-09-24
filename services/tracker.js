const roblox = require('./roblox');
const STATUS_HEARTBEAT_MS = Math.max(15000, Number(process.env.STATUS_HEARTBEAT_MS) || 60000);

class Tracker {
  constructor(io, { intervalMs = 15000, store, notify = async () => {} } = {}) {
    this.io = io;
    this.store = store;
    this.notify = notify;
    this.intervalMs = Math.max(5000, Number(intervalMs) || 15000);
    this.lastStatus = new Map();
    this.timer = null;
    this.reauthTimer = null;
    this.polling = false;
    this.lastPollAt = null;
    this.lastError = null;
    this.backoffMs = 0;
    this.consecutiveRateLimits = 0;
    this.lastPollDurationMs = null;
    this.pollCount = 0;
    this.failedPollCount = 0;
    this.transientFailureCount = 0;
    this.staticCache = { users: new Map(), avatars: new Map(), universes: new Map(), games: new Map() };
    this.userErrors = new Map();
    this.lastStatusPersistedAt = new Map();
  }

  start() {
    if (this.timer) return;
    this.pollOnce().catch(e => console.error(`[tracker:${this.store.guildId}] initial poll:`, e.message));
    const jitter = Math.floor(Math.random() * 2000);
    this.schedule(this.intervalMs + jitter);
    this.reauthTimer = setInterval(() => this.reverifyAccounts().catch(() => {}), 15 * 60 * 1000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.reauthTimer) clearInterval(this.reauthTimer);
    this.timer = this.reauthTimer = null;
    this.polling = false;
  }

  schedule(delay = this.intervalMs) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { await this.pollOnce(); }
      catch (e) { console.error(`[tracker:${this.store.guildId}] poll:`, e.message); }
      finally { this.schedule(this.backoffMs || this.intervalMs); }
    }, Math.max(250, Number(delay) || this.intervalMs));
  }

  setIntervalMs(ms) {
    this.intervalMs = Math.max(5000, Number(ms) || 15000);
    this.backoffMs = 0;
    this.consecutiveRateLimits = 0;
    this.schedule(this.intervalMs);
  }

  getSnapshot() { return [...this.lastStatus.values()]; }

  pruneCache(map, ttlMs) {
    const cutoff = Date.now() - ttlMs;
    for (const [key, value] of map) if (value?.at < cutoff) map.delete(key);
  }

  pruneCaches() {
    this.pruneCache(this.staticCache.users, 6 * 60 * 60 * 1000);
    this.pruneCache(this.staticCache.avatars, 60 * 60 * 1000);
    this.pruneCache(this.staticCache.universes, 24 * 60 * 60 * 1000);
    this.pruneCache(this.staticCache.games, 6 * 60 * 60 * 1000);
  }

  reconcileSnapshots(users) {
    const active = new Set(users.filter(user => user.enabled !== false).map(user => user.username.toLowerCase()));
    for (const key of this.lastStatus.keys()) if (!active.has(key)) this.lastStatus.delete(key);
    for (const key of this.userErrors.keys()) if (!active.has(key)) this.userErrors.delete(key);
    for (const key of this.lastStatusPersistedAt.keys()) if (!active.has(key)) this.lastStatusPersistedAt.delete(key);
  }

  // True only when every tracked user in the live snapshot is offline / not
  // in a game, except the given username (who must be in-game).
  isSoloInGame(username) {
    const target = String(username || '').toLowerCase();
    let targetFound = false;
    for (const s of this.lastStatus.values()) {
      const u = (s.username || '').toLowerCase();
      if (u === target) {
        if (!s.inGame) return false;
        targetFound = true;
      } else if (s.inGame) {
        return false;
      }
    }
    return targetFound;
  }
  getMeta() {
    const users = this.store.getUsers();
    return {
      polling: this.polling,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      intervalMs: this.intervalMs,
      backoffMs: this.backoffMs,
      consecutiveRateLimits: this.consecutiveRateLimits,
      lastPollDurationMs: this.lastPollDurationMs,
      pollCount: this.pollCount,
      failedPollCount: this.failedPollCount,
      transientFailureCount: this.transientFailureCount,
      tracked: users.length,
      enabledTracked: users.filter(u => u.enabled !== false).length,
      api: roblox.getHealth(),
    };
  }

  async reverifyAccounts() {
    for (const a of this.store.getEnabledAccounts()) {
      try {
        const auth = await roblox.checkAuth(a.cookie);
        const refreshed = roblox.takeRefreshedCookie(a.cookie);
        this.store.updateAccount(a.id, { lastAuth: auth, lastError: null, ...(refreshed ? { cookie: refreshed } : {}) }, { revision: false });
      } catch (e) {
        this.store.updateAccount(a.id, { lastError: sanitizeError(e).message }, { revision: false });
      }
    }
  }

  cacheFresh(map, key, ttlMs) {
    const v = map.get(key);
    return v && (Date.now() - v.at < ttlMs) ? v.value : null;
  }
  cacheSet(map, key, value) { map.set(key, { value, at: Date.now() }); }

  async cachedResolve(usernames) {
    const result = new Map();
    const missing = [];
    for (const name of usernames) {
      const key = name.toLowerCase();
      const cached = this.cacheFresh(this.staticCache.users, key, 6 * 60 * 60 * 1000);
      if (cached) result.set(key, cached); else missing.push(name);
    }
    if (missing.length) {
      const fresh = await roblox.resolveUsernames(missing);
      for (const [key, value] of fresh.entries()) { this.cacheSet(this.staticCache.users, key, value); result.set(key, value); }
    }
    return result;
  }

  async cachedAvatars(ids) {
    const result = new Map(), missing = [];
    for (const id of ids) {
      const cached = this.cacheFresh(this.staticCache.avatars, id, 60 * 60 * 1000);
      if (cached) result.set(id, cached); else missing.push(id);
    }
    if (missing.length) {
      const fresh = await roblox.getAvatars(missing);
      for (const [id, value] of fresh.entries()) { this.cacheSet(this.staticCache.avatars, id, value); result.set(id, value); }
    }
    return result;
  }

  async cachedUniverses(placeIds) {
    const result = new Map(), missing = [];
    for (const id of placeIds) {
      const cached = this.cacheFresh(this.staticCache.universes, id, 24 * 60 * 60 * 1000);
      if (cached) result.set(id, cached); else missing.push(id);
    }
    if (missing.length) {
      const fresh = await roblox.getUniverseIdsFromPlaceIds(missing);
      for (const [id, value] of fresh.entries()) { this.cacheSet(this.staticCache.universes, id, value); result.set(id, value); }
    }
    return result;
  }

  async cachedGames(ids) {
    const result = new Map(), missing = [];
    for (const id of ids) {
      const cached = this.cacheFresh(this.staticCache.games, id, 6 * 60 * 60 * 1000);
      if (cached) result.set(id, cached); else missing.push(id);
    }
    if (missing.length) {
      const fresh = await roblox.getGameNames(missing);
      for (const [id, value] of fresh.entries()) { this.cacheSet(this.staticCache.games, id, value); result.set(id, value); }
    }
    return result;
  }

  getSessionDuration(username) {
    const status = this.lastStatus.get(String(username || '').toLowerCase());
    if (!status?.inGame || !status.sessionStartedAt) return null;
    const startedAt = new Date(status.sessionStartedAt).getTime();
    return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
  }

  recordUserError(username, source, message, context = {}) {
    const key = String(username || '').toLowerCase();
    const fingerprint = JSON.stringify([source, message, context]);
    if (this.userErrors.get(key) === fingerprint) return;
    this.userErrors.set(key, fingerprint);
    this.store.appendUserError(username, source, message, context);
  }

  clearUserError(username) {
    this.userErrors.delete(String(username || '').toLowerCase());
  }

  static inferServerType(s) {
    if (!s || !s.inGame) return null;
    // A game join carries a gameId (private server instance id). When we have
    // a place id but no instance id, the join link is unavailable, which is
    // typical for invite-only / friend-only games.
    return s.gameId ? 'public' : 'private';
  }

  async pollOnce() {
    if (this.polling) return false;
    this.polling = true;
    const started = Date.now();
    try {
      this.pruneCaches();
      const pollRevision = this.store.getRevision();
      const users = this.store.getUsers().filter(u => u.enabled !== false);
      this.reconcileSnapshots(users);
      const accountMap = this.store.getAccountMap();
      for (const user of users) {
        const key = user.username.toLowerCase();
        if (!this.lastStatus.has(key)) {
          const persisted = this.store.getUserStatus(user.username);
          if (persisted) this.lastStatus.set(key, persisted);
        }
      }
      if (!users.length) { this.lastPollAt = new Date().toISOString(); this.pollCount++; this.lastError = null; this.backoffMs = 0; this.consecutiveRateLimits = 0; return true; }

      const resolved = await roblox.retryable(() => this.cachedResolve(users.map(u => u.username)), 'resolve usernames');
      const ids = [...resolved.values()].map(u => u.id);
      let avatars = new Map();
      try { avatars = await roblox.retryable(() => this.cachedAvatars(ids), 'avatars'); }
      catch (e) { this.transientFailureCount++; this.lastError = `avatar lookup: ${sanitizeError(e).message}`; }

      const byAccount = new Map();
      for (const u of users) {
        if (!u.accountId) continue;
        if (!byAccount.has(u.accountId)) byAccount.set(u.accountId, []);
        byAccount.get(u.accountId).push(u);
      }

      const presence = new Map();
      const accountErrors = new Map();
      for (const [accountId, group] of byAccount) {
        const account = accountMap.get(accountId);
        if (!account || account.enabled === false || !account.cookie) {
          accountErrors.set(accountId, new Error('Linked cookie account is unavailable or disabled.'));
          continue;
        }
        const idsFor = group.map(u => resolved.get(u.username.toLowerCase())?.id).filter(Boolean);
        if (!idsFor.length) continue;
        try {
          const ps = await roblox.retryable(() => roblox.getPresences(idsFor, account.cookie), `presence ${accountId}`);
          for (const [id, p] of ps) presence.set(`${accountId}:${id}`, p);
          this.store.updateAccount(accountId, { lastError: null }, { revision: false });
          const refreshed = roblox.takeRefreshedCookie(account.cookie);
          if (refreshed) this.store.updateAccount(accountId, { cookie: refreshed }, { revision: false });
        } catch (e) {
          const clean = sanitizeError(e);
          accountErrors.set(accountId, clean);
          this.store.updateAccount(accountId, { lastError: clean.message }, { revision: false });
          this.transientFailureCount++;
          if (clean.status === 429) {
            this.lastError = clean.message;
            throw clean;
          }
        }
      }

      const places = [...presence.values()].filter(p => p.type === 2 && !p.universeId && p.placeId).map(p => p.placeId);
      let universes = new Map();
      if (places.length) {
        try { universes = await roblox.retryable(() => this.cachedUniverses(places), 'place details'); }
        catch (e) { this.transientFailureCount++; this.lastError = `place lookup: ${sanitizeError(e).message}`; }
      }
      for (const p of presence.values()) if (!p.universeId && p.placeId && universes.has(p.placeId)) p.universeId = universes.get(p.placeId);

      let names = new Map();
      const universeIds = [...presence.values()].map(p => p.universeId).filter(Boolean);
      if (universeIds.length) {
        try { names = await roblox.retryable(() => this.cachedGames(universeIds), 'game names'); }
        catch (e) { this.transientFailureCount++; this.lastError = `game lookup: ${sanitizeError(e).message}`; }
      }

      // Pre-compute server classification in ONE batched RoValra pass instead of
      // one API call per in-game user, then fetch player counts in parallel
      // (bounded) — but only when the embed will actually show them.
      const serverDetails = new Map(); // gameId -> rovalra entry
      const serverPlayersById = new Map(); // gameId -> {playing, maxPlayers}
      const wantServerInfo = this.store.getServerInfo();
      const byPlace = new Map();
      for (const u of users) {
        const info = resolved.get(u.username.toLowerCase());
        if (!info) continue;
        const account = u.accountId ? accountMap.get(u.accountId) : null;
        let p = null;
        if (account) {
          if (account.enabled === false || !account.cookie || accountErrors.has(account.id)) continue;
          const pkey = `${account.id}:${info.id}`;
          if (!presence.has(pkey)) continue;
          p = presence.get(pkey);
        }
        if (p && p.type === 2 && Boolean(p.placeId || p.universeId) && p.gameId) {
          const place = p.rootPlaceId || p.placeId || null;
          if (!byPlace.has(place)) byPlace.set(place, []);
          byPlace.get(place).push(p.gameId);
        }
      }
      await Promise.all([...byPlace.entries()].map(async ([place, ids]) => {
        try {
          const details = await roblox.getRovalraServerDetails(place, ids);
          for (const [id, entry] of details) serverDetails.set(id, entry);
        } catch (e) {
          this.transientFailureCount++;
          this.lastError = `server classify: ${sanitizeError(e).message}`;
          if (this.lastStatus.size) this.io?.emit('poll-error', { error: this.lastError });
        }
      }));
      const wantPlayerCount = new Map();
      if (wantServerInfo) {
        for (const u of users) {
          const info = resolved.get(u.username.toLowerCase());
          if (!info) continue;
          const account = u.accountId ? accountMap.get(u.accountId) : null;
          let p = null;
          if (account) {
            if (account.enabled === false || !account.cookie || accountErrors.has(account.id)) continue;
            const pkey = `${account.id}:${info.id}`;
            if (!presence.has(pkey)) continue;
            p = presence.get(pkey);
          }
          if (p && p.type === 2 && Boolean(p.placeId || p.universeId) && p.gameId && serverDetails.has(p.gameId)) {
            wantPlayerCount.set(p.gameId, p.rootPlaceId || p.placeId || null);
          }
        }
        const ids = [...wantPlayerCount.keys()];
        const steps = runBounded(ids, 3, async id => {
          try { return [id, await roblox.getServerPlayerCount(wantPlayerCount.get(id), id)]; }
          catch { return [id, null]; }
        });
        for (const [id, count] of await steps) if (count) serverPlayersById.set(id, count);
      }

      if (pollRevision !== this.store.getRevision()) return false;
      for (const u of users) {
        const info = resolved.get(u.username.toLowerCase());
        if (!info) {
          this.recordUserError(u.username, 'resolve', 'Username not found', { stage: 'resolve' });
          this.publish(u, { username: u.username, resolved: false, error: 'Username not found', status: 'Unknown', updatedAt: new Date().toISOString() });
          continue;
        }
        // API is in a degraded (sustained-failure) state. Presence data can no
        // longer be trusted, so hold each user's last-known state and do not
        // emit transitions — otherwise a Roblox outage would look like every
        // tracked user suddenly going offline at once.
        if (roblox.isDegraded()) {
          this.lastError = `Roblox API degraded; holding ${this.lastStatus.size}/${users.length} user states`;
          this.recordUserError(u.username, 'roblox-api', 'Roblox API degraded; holding last-known state', { stage: 'poll' });
          this.io?.emit('poll-error', { username: info.name, error: 'Roblox API degraded; holding last-known state' });
          continue;
        }
        const account = u.accountId ? accountMap.get(u.accountId) : null;
        if (account && accountErrors.has(account.id)) {
          // Do not turn a temporary API/auth/network failure into a false Offline transition.
          const accountError = accountErrors.get(account.id);
          this.recordUserError(u.username, 'account', accountError.message, { stage: 'presence', accountId: account.id, accountName: account.name });
          this.io?.emit('poll-error', { username: info.name, error: accountError.message });
          continue;
        }
        const pkey = account ? `${account.id}:${info.id}` : null;
        if (account && !presence.has(pkey)) {
          // Roblox returned a response that is missing this cookie-backed user.
          // Presence can come back incomplete/weird during API trouble; do NOT
          // assume they went offline. Hold last-known state instead.
          this.transientFailureCount++;
          this.lastError = `Incomplete presence data for ${info.name}`;
          this.recordUserError(u.username, 'presence', this.lastError, { stage: 'presence', accountId: account.id, accountName: account.name });
          this.io?.emit('poll-error', { username: info.name, error: this.lastError });
          continue;
        }
        const p = account ? presence.get(pkey) : { type: -1, label: 'No cookie account' };
        this.clearUserError(u.username);
        const inGame = p.type === 2;
        const place = p.rootPlaceId || p.placeId || null;
        const gameInfo = p.universeId ? names.get(p.universeId) : null;
        const gameName = typeof gameInfo === 'object' ? gameInfo?.name : gameInfo;
        const joinsVisible = inGame ? Boolean(p.placeId || p.universeId) : null;
        //Public/private discrimination: a presence gameId alone is ambiguous
        //(private/VIP servers also expose one). RoValra only indexes public
        //servers, so a details-API hit confirms public and carries region + uptime.
        //Unknown (no RoValra hit) stays null - never guess private.
        let serverType = inGame ? (joinsVisible ? null : 'joins-off') : null;
        let serverRegion = null;
        let serverUptimeMs = null;
        let serverPlayers = null;
        if (inGame && joinsVisible && p.gameId) {
          const info = serverDetails.get(p.gameId);
          if (info) {
            serverType = 'public';
            serverRegion = info.region;
            serverUptimeMs = info.uptimeMs;
            serverPlayers = serverPlayersById.get(p.gameId) || null;
          }
        }
        const now = Date.now();
        const previous = this.lastStatus.get(info.name.toLowerCase());
        const sessionStartedAt = inGame
          ? previous?.inGame ? (previous.sessionStartedAt || previous.updatedAt || new Date(now).toISOString()) : new Date(now).toISOString()
          : null;
        const sessionDurationMs = sessionStartedAt ? Math.max(0, now - new Date(sessionStartedAt).getTime()) : null;

        const snapshot = {
          username: info.name,
          displayName: info.displayName,
          userId: info.id,
          avatarUrl: avatars.get(info.id) || null,
          accountId: u.accountId,
          accountName: account?.name || null,
          resolved: p.type !== -1,
          error: p.error || null,
          presenceType: p.type,
          status: p.label,
          inGame,
          joinsVisible,
          gameName: gameName || null,
          serverType,
          serverRegion,
          serverUptimeMs,
          serverPlayers,
          sessionDurationMs,
          sessionStartedAt,
          placeId: p.placeId || null,
          gameId: p.gameId || null,
          gameUrl: place ? `https://www.roblox.com/games/${place}` : null,
          joinUrl: place && p.gameId ? `https://www.roblox.com/games/start?placeId=${encodeURIComponent(place)}&gameInstanceId=${encodeURIComponent(p.gameId)}` : null,
          robloxDeepLink: place && p.gameId ? `roblox://experiences/start?placeId=${encodeURIComponent(place)}&gameInstanceId=${encodeURIComponent(p.gameId)}` : null,
          updatedAt: new Date().toISOString(),
        };
        this.publish(u, snapshot);
      }

      this.lastPollAt = new Date().toISOString();
      this.pollCount++;
      this.lastError = null;
      this.backoffMs = 0;
      this.consecutiveRateLimits = 0;
      return true;
    } catch (e) {
      const clean = sanitizeError(e);
      this.lastError = clean.message;
      this.failedPollCount++;
      if (clean.status === 429 || /rate.?limit/i.test(clean.message)) {
        this.consecutiveRateLimits++;
        this.backoffMs = Number(clean.retryAfterMs) || Math.min(120000, Math.max(this.intervalMs * 2, this.backoffMs ? this.backoffMs * 2 : 10000));
      } else {
        this.backoffMs = Math.min(30000, Math.max(5000, this.backoffMs ? Math.floor(this.backoffMs * 1.5) : 5000));
      }
      throw clean;
    } finally {
      this.polling = false;
      this.lastPollDurationMs = Date.now() - started;
    }
  }

  publish(user, s) {
    const oldKey = user.username.toLowerCase();
    let prev = this.lastStatus.get(oldKey);
    if (s.username && s.username.toLowerCase() !== oldKey) {
      try {
        const renamed = this.store.renameUser(user.username, s.username);
        if (renamed) {
          this.lastStatus.delete(oldKey);
          this.lastStatusPersistedAt.delete(oldKey);
          this.userErrors.delete(oldKey);
          user = renamed;
          prev = this.lastStatus.get(user.username.toLowerCase()) || prev;
        }
      } catch (error) {
        console.warn(`[tracker:${this.store.guildId}] username rename failed:`, error.message);
      }
    }
    const key = user.username.toLowerCase();
    const changed = !prev || prev.status !== s.status || prev.gameName !== s.gameName || prev.gameId !== s.gameId || prev.placeId !== s.placeId || prev.inGame !== s.inGame || prev.resolved !== s.resolved;
    this.lastStatus.set(key, s);
    const lastPersisted = this.lastStatusPersistedAt.get(key) || 0;
    if (changed || Date.now() - lastPersisted >= STATUS_HEARTBEAT_MS) {
      this.store.setUserStatus(user.username, s);
      this.lastStatusPersistedAt.set(key, Date.now());
    }
    if (!changed) { this.io?.emit('status', s); return; }

    const rawEvent = getEventType(prev, s);
    const policies = this.store.getNotificationPolicies(user.username);
    const allow = type => policies[type]?.enabled !== false;

    // gameLeave takes priority over online/offline for in-game -> not-in-game
    // transitions. If gameLeave is disabled (and only then), fall back to
    // online or offline so the admin does not lose visibility entirely.
    let eventType = rawEvent;
    if (rawEvent === 'gameLeave' && !allow('gameLeave')) {
      eventType = s.status === 'Offline' ? 'offline' : 'online';
    }

    // The new snapshot does not contain game info once the user has left,
    // so synthesize the leave notification payload from the previous state
    // and the recorded session start.
    const payload = eventType === 'gameLeave' ? {
      ...s,
      gameName: prev?.gameName || null,
      placeId: prev?.placeId || null,
      gameId: prev?.gameId || null,
      serverType: prev?.serverType || null,
      sessionDurationMs: prev?.sessionStartedAt ? Math.max(0, Date.now() - new Date(prev.sessionStartedAt).getTime()) : null,
      eventType: 'gameLeave',
    } : { ...s, eventType };

    this.store.appendHistory(user.username, { status: s.status, gameName: payload.gameName, accountName: s.accountName, inGame: s.inGame, placeId: payload.placeId, gameId: payload.gameId, eventType });
    this.io?.emit('status-change', { ...payload });
    if (prev && s.resolved && allow(eventType)) this.notify(payload).catch(e => console.warn(`[tracker:${this.store.guildId}] notification failed:`, e.message));
    this.io?.emit('status', s);
  }
}

// Run async work over a list with at most `limit` concurrent executions.
// Preserves input order in the returned array.
async function runBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return out;
}

function sanitizeError(e) {
  const err = e instanceof Error ? e : new Error(String(e || 'Unknown error'));
  if (e?.status != null) err.status = Number(e.status);
  if (e?.retryAfterMs != null) err.retryAfterMs = Number(e.retryAfterMs);
  return err;
}

function getEventType(prev, next) {
  if (!prev) return 'initial';
  // In Game -> anything-not-in-game is a gameLeave. The actual eventType used
  // for delivery may be downgraded to online/offline in publish() if the
  // admin has disabled the gameLeave notification.
  if (prev.inGame && !next.inGame) return 'gameLeave';
  const a = prev.resolved && prev.status !== 'Offline';
  const b = next.resolved && next.status !== 'Offline';
  if (a && !b) return 'offline';
  if (!a && b) return 'online';
  if (!prev.inGame && next.inGame) return 'gameJoin';
  if (prev.inGame && next.inGame && (prev.gameName !== next.gameName || prev.gameId !== next.gameId || prev.placeId !== next.placeId)) return 'gameChange';
  return 'status';
}

Tracker.getEventType = getEventType;
module.exports = Tracker;
