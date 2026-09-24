// services/roblox.js
// Thin wrapper around the public Roblox web APIs used by Alicia Tracker.
//
// Endpoints used:
//   - POST https://users.roblox.com/v1/usernames/users
//       username -> userId lookup (bulk, up to 100 usernames per call)
//   - POST https://presence.roblox.com/v1/presence/users
//       userId -> presence (offline / online / in-game / in-studio)
//   - GET  https://thumbnails.roblox.com/v1/users/avatar-headshot
//       userId -> avatar image url
//   - GET  https://games.roblox.com/v1/games
//       universeId -> game name (so we can show "playing <Game Name>")
//
// None of these require authentication for basic presence data. They are
// rate limited by Roblox, so everything here is batched (one request for
// many users) rather than looped per-user.

const USERS_API = 'https://users.roblox.com/v1/usernames/users';
const AUTH_CHECK_API = 'https://users.roblox.com/v1/users/authenticated';
const PRESENCE_API = 'https://presence.roblox.com/v1/presence/users';
const THUMB_API = 'https://thumbnails.roblox.com/v1/users/avatar-headshot';
const GAMES_API = 'https://games.roblox.com/v1/games';
const PLACE_DETAILS_API = 'https://games.roblox.com/v1/games/multiget-place-details';
const ROVALRA_DETAILS_API = 'https://apis.rovalra.com/v1/servers/details';
const ROVALRA_UA = 'RoValraExtension(RoValra/Chrome/Chromium/version/Production)';

const PRESENCE_LABEL = {
  0: 'Offline',
  1: 'Online',
  2: 'In Game',
  3: 'In Studio',
};

// Roblox requires an x-csrf-token header on authenticated (cookie-bearing)
// POST requests. You don't get to pick the token — the first request comes
// back 403 with the correct token in a response header, then you retry with
// it. We cache it in memory so we only eat that extra round trip once.
const csrfTokens = new Map();
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.ROBLOX_REQUEST_TIMEOUT_MS) || 15000);
const MAX_RETRIES = Math.max(0, Number(process.env.ROBLOX_MAX_RETRIES) || 2);

const DEGRADED_THRESHOLD = Math.max(1, Number(process.env.ROBLOX_DEGRADED_THRESHOLD) || 3);

// API health/state layer. Transient Roblox outages (timeouts, 5xx, weird
// partial responses) should not be mistaken for users actually going offline.
// Every successful request resets the failure count; once we exceed the
// threshold we flag the API as "degraded" so the tracker holds last-known
// state instead of fabricating offline transitions.
const health = {
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastFailure: null,
  lastSuccessAt: null,
  status: 'healthy', // 'healthy' | 'degraded'
};

function recordSuccess() {
  health.consecutiveFailures = 0;
  health.lastSuccessAt = Date.now();
  health.lastFailure = null;
  health.status = 'healthy';
}

function recordFailure(err) {
  health.consecutiveFailures++;
  health.lastFailureAt = Date.now();
  health.lastFailure = err?.message || 'Roblox API failure';
  if (health.consecutiveFailures >= DEGRADED_THRESHOLD) health.status = 'degraded';
}

function isDegraded() { return health.status === 'degraded'; }
function getHealth() {
  return {
    ...health,
    degradedThreshold: DEGRADED_THRESHOLD,
  };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function retryable(fn, label = 'request', attempts = MAX_RETRIES + 1) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn();
      recordSuccess();
      return result;
    }
    catch (e) {
      lastError = e;
      const status = Number(e?.status || 0);
      const retryableStatus = status === 429 || status >= 500;
      const retryableNetwork = !status && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(e?.code);
      if (attempt >= attempts || (!retryableStatus && !retryableNetwork)) {
        recordFailure(e);
        break;
      }
      const wait = Number(e?.retryAfterMs) || Math.min(5000, 500 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
      await sleep(wait);
    }
  }
  lastError = lastError || new Error(`${label} failed`);
  throw lastError;
}


// Roblox uses sliding-session .ROBLOSECURITY cookies: while a cookie is
// still valid, an authenticated request can come back with a freshly
// ROTATED value in the Set-Cookie response header, extending the session.
// Scripts that only ever send the cookie they were originally given (and
// never look at Set-Cookie) miss this — the old value keeps working for a
// while, then goes stale all at once, which is exactly what caused "joins
// hidden" earlier. We capture rotations here; callers use takeRefreshedCookie()
// after each request to know if they should persist a new value.
const refreshedCookies = new Map(); // old cookie value -> newest known value

function captureRefreshedCookie(res, cookie) {
  if (!cookie) return;
  let setCookieValues = [];
  if (typeof res.headers.getSetCookie === 'function') {
    setCookieValues = res.headers.getSetCookie(); // Node 20+ / undici
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) setCookieValues = [raw];
  }
  for (const sc of setCookieValues) {
    const match = /\.ROBLOSECURITY=([^;]+)/.exec(sc);
    if (match && match[1]) {
      const newValue = decodeURIComponent(match[1]);
      if (newValue && newValue !== cookie) refreshedCookies.set(cookie, newValue);
    }
  }
}

/**
 * Call after using a cookie for a request. Returns the rotated value if
 * Roblox issued one since the last check, and clears it (one-shot) — the
 * caller is expected to persist it (store.updateAccount) and use the new
 * value going forward.
 */
function takeRefreshedCookie(cookie) {
  const v = refreshedCookies.get(cookie);
  if (v) refreshedCookies.delete(cookie);
  return v || null;
}

// Roblox's presence endpoint has been repeatedly reported (Roblox DevForum:
// "Presence API doesn't return all values" / "Problem with presence API")
// to hand back a stripped-down response — no placeId/gameId/universeId,
// just userPresenceType — to requests that don't look like they came from
// an actual browser, EVEN with a fully valid, authenticated cookie. A
// request with only Content-Type + Cookie is exactly that shape. Sending
// a real User-Agent/Referer/Origin fixes this for most accounts; it does
// NOT fix privacy settings that are genuinely scoped to friends-only.
function headers(cookie, extra = {}) {
  const h = {
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    Referer: 'https://www.roblox.com/',
    Origin: 'https://www.roblox.com',
    Accept: 'application/json, text/plain, */*',
    ...extra,
  };
  if (cookie) {
    h['Cookie'] = `.ROBLOSECURITY=${cookie}`;
    const token = csrfTokens.get(cookie);
    if (token) h['x-csrf-token'] = token;
  }
  return h;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error(`Roblox API request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      timeoutErr.code = 'ETIMEDOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(url, body, cookie = '') {
  let res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: headers(cookie),
    body: JSON.stringify(body),
  });
  captureRefreshedCookie(res, cookie);

  // Authenticated POSTs may require an x-csrf-token. Cache one per cookie.
  if (res.status === 403 && res.headers.get('x-csrf-token') && cookie) {
    csrfTokens.set(cookie, res.headers.get('x-csrf-token'));
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: headers(cookie),
      body: JSON.stringify(body),
    });
    captureRefreshedCookie(res, cookie);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Roblox API ${url} responded ${res.status}: ${text}`);
    err.status = res.status;
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) err.retryAfterMs = Math.max(0, Number(retryAfter) * 1000 || 0);
    throw err;
  }
  return res.json();
}

async function getJson(url, cookie = '') {
  const res = await fetchWithTimeout(url, { headers: headers(cookie) });
  captureRefreshedCookie(res, cookie);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Roblox API ${url} responded ${res.status}: ${text}`);
    err.status = res.status;
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) err.retryAfterMs = Math.max(0, Number(retryAfter) * 1000 || 0);
    throw err;
  }
  return res.json();
}

/**
 * Verify the ROBLOX_COOKIE (if set) is actually a valid, logged-in session,
 * and return who it's logged in as. Called once at startup so a bad/expired
 * cookie shows up immediately in the logs instead of silently degrading to
 * anonymous (privacy-gated) presence data.
 * @returns {Promise<{id:number, name:string, displayName:string} | null>}
 *   null if no cookie is configured
 */
async function checkAuth(cookie = process.env.ROBLOX_COOKIE) {
  if (!cookie) return null;
  const res = await fetchWithTimeout(AUTH_CHECK_API, { headers: headers(cookie) });
  captureRefreshedCookie(res, cookie);
  if (res.status === 401) {
    throw new Error('ROBLOX_COOKIE is set but Roblox rejected it (expired or invalid .ROBLOSECURITY value)');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Auth check failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  return { id: data.id, name: data.name, displayName: data.displayName };
}

/**
 * Resolve one or more usernames to Roblox user info.
 * @param {string[]} usernames
 * @returns {Promise<Map<string, {id:number, name:string, displayName:string}>>}
 *   keyed by lowercase username for easy lookup
 */
async function resolveUsernames(usernames, cookie = '') {
  const unique = [...new Set(usernames)];
  const map = new Map();
  if (unique.length === 0) return map;

  // Roblox accepts up to 100 usernames per call.
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const data = await postJson(USERS_API, {
      usernames: chunk,
      excludeBannedUsers: false,
    }, cookie);
    for (const u of data.data || []) {
      map.set(u.requestedUsername.toLowerCase(), {
        id: u.id,
        name: u.name,
        displayName: u.displayName,
      });
    }
  }
  return map;
}

/**
 * Get presence for a batch of user IDs.
 * @param {number[]} userIds
 * @returns {Promise<Map<number, object>>} keyed by userId
 */
async function getPresences(userIds, cookie = '') {
  const unique = [...new Set(userIds)];
  const map = new Map();
  if (unique.length === 0) return map;

  // Roblox accepts up to 100 user IDs per call.
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const data = await postJson(PRESENCE_API, { userIds: chunk }, cookie);
    for (const p of data.userPresences || []) {
      map.set(p.userId, {
        type: p.userPresenceType,
        label: PRESENCE_LABEL[p.userPresenceType] ?? 'Unknown',
        lastLocation: p.lastLocation || null,
        placeId: p.placeId || null,
        rootPlaceId: p.rootPlaceId || null,
        gameId: p.gameId || null,
        universeId: p.universeId || null,
      });
    }
  }
  return map;
}

/**
 * Get avatar headshot thumbnail URLs for a batch of user IDs.
 * @param {number[]} userIds
 * @returns {Promise<Map<number, string>>}
 */
async function getAvatars(userIds) {
  const unique = [...new Set(userIds)];
  const map = new Map();
  if (unique.length === 0) return map;

  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const url = `${THUMB_API}?userIds=${chunk.join(',')}&size=150x150&format=Png&isCircular=false`;
    const data = await getJson(url);
    for (const t of data.data || []) {
      if (t.state === 'Completed') map.set(t.targetId, t.imageUrl);
    }
  }
  return map;
}

/**
 * Fallback: resolve universeId from placeId. The presence API usually
 * returns universeId directly, but occasionally only hands back
 * placeId/rootPlaceId (still gated by the user's "who can see what I'm
 * playing" / joins privacy setting). This fills the gap so the game
 * name still shows up whenever Roblox exposes a place at all.
 * @param {number[]} placeIds
 * @returns {Promise<Map<number, number>>} placeId -> universeId
 */
async function getUniverseIdsFromPlaceIds(placeIds) {
  const unique = [...new Set(placeIds.filter(Boolean))];
  const map = new Map();
  if (unique.length === 0) return map;

  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const url = `${PLACE_DETAILS_API}?placeIds=${chunk.join(',')}`;
    const data = await getJson(url); // this endpoint returns a bare array, not { data: [...] }
    const list = Array.isArray(data) ? data : data.data || [];
    for (const p of list) {
      if (p.universeId) map.set(p.placeId, p.universeId);
    }
  }
  return map;
}

/**
 * Get game names for a batch of universe IDs.
 * @param {number[]} universeIds
 * @returns {Promise<Map<number, string>>}
 */
async function getGameNames(universeIds) {
  const unique = [...new Set(universeIds.filter(Boolean))];
  const map = new Map();
  if (unique.length === 0) return map;

  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const url = `${GAMES_API}?universeIds=${chunk.join(',')}`;
    const data = await getJson(url);
    for (const g of data.data || []) {
      map.set(g.id, { name: g.name, playing: Number.isFinite(g.playing) ? g.playing : null });
    }
  }
return map;
}
// RoValra (https://www.rovalra.com) exposes a public server-details API that
// enriches a Roblox game instance id with datacenter region and uptime. RoValra
// only indexes PUBLIC servers, so a hit here also confirms the instance is a
// public server (a private/VIP server gets no entry). No auth required; just
// the RoValra user-agent header.
const rovalraCache = new Map();
const ROVALRA_NEGATIVE_TTL_MS = Math.max(30000, Number(process.env.ROVALRA_NEGATIVE_TTL_MS) || 10 * 60 * 1000);
const MAX_CACHE_ENTRIES = Math.max(100, Number(process.env.ROBLOX_CACHE_MAX_ENTRIES) || 2000);
function cacheSetLimited(map, key, value) {
  if (map.has(key)) { map.set(key, value); return; }
  if (map.size >= MAX_CACHE_ENTRIES) {
    // Drop the oldest entries (Map preserves insertion order) until we fit.
    const extra = map.size - MAX_CACHE_ENTRIES + 1;
    let dropped = 0;
    for (const k of map.keys()) {
      map.delete(k);
      if (++dropped >= extra) break;
    }
  }
  map.set(key, value);
}
async function getRovalraServerDetails(placeId, serverIds) {
  const unique = [...new Set(serverIds.filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;
  const now = Date.now();
  let missing = [];
  for (const id of unique) {
    const cached = rovalraCache.get(id);
    if (cached && (cached.firstSeenMs != null || now - cached.at < ROVALRA_NEGATIVE_TTL_MS)) {
      // Uptime keeps growing while the server lives; recompute from the
      // cached firstSeen instead of returning a frozen value. A cached miss
      // (negative entry) must NOT be returned as a hit — it only avoids
      // re-fetching the RoValra API within the TTL window.
      if (cached.firstSeenMs != null) map.set(id, { ...cached, uptimeMs: Math.max(0, now - cached.firstSeenMs) });
    } else missing.push(id);
  }
  if (!missing.length) return map;
  for (let i = 0; i < missing.length; i += 10) {
    const chunk = missing.slice(i, i + 10);
    const res = await fetchWithTimeout(`${ROVALRA_DETAILS_API}?place_id=${encodeURIComponent(placeId)}&server_ids=${chunk.join(',')}`, { headers: { Accept: 'application/json', 'x-rovalra-user-agent': ROVALRA_UA } });
    if (!res.ok) throw new Error(`RoValra API responded ${res.status}`);
    const data = await res.json();
    for (const s of data.servers || []) {
      const firstSeenMs = s.first_seen ? new Date(s.first_seen).getTime() : null;
      const entry = {
        serverId: s.server_id,
        at: now,
        firstSeenMs,
        region: [s.city, s.region, s.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ') || null,
        regionCode: s.region_code || null,
        city: s.city || null,
        country: s.country || null,
        uptimeMs: firstSeenMs != null ? Math.max(0, now - firstSeenMs) : null,
        placeVersion: s.place_version || null,
        ipAddress: s.ip_address || null,
        datacenterId: s.datacenter_id || null,
      };
      cacheSetLimited(rovalraCache, s.server_id, entry);
      map.set(s.server_id, entry);
    }
    for (const id of chunk) {
      if (!map.has(id)) cacheSetLimited(rovalraCache, id, { serverId: id, at: now, firstSeenMs: null, uptimeMs: null });
    }
  }
  return map;
}
// Public-server player count. Roblox's game server-list API is the only
// free/no-auth source that reports how many players are inside a specific
// public server instance (RoValra only gives region/uptime, not counts, and
// gamejoin requires an authenticated session). We paginate the place's
// PUBLIC server list until we match the exact server id — the same id the
// presence API already handed us — then read its playing/max counts.
const GAME_SERVERS_API = 'https://games.roblox.com/v1/games/%place%/servers/Public';
const pcCache = new Map(); // serverId -> { playing, maxPlayers, at }
const PC_CACHE_TTL_MS = Math.max(15000, Number(process.env.PLAYER_COUNT_CACHE_MS) || 60 * 1000);
const PC_MAX_PAGES = Math.max(1, Number(process.env.PLAYER_COUNT_MAX_PAGES) || 6);
const PC_PAGE_DELAY_MS = 600;
async function getServerPlayerCount(placeId, serverId) {
  if (!placeId || !serverId) return null;
  const now = Date.now();
  const cached = pcCache.get(serverId);
  if (cached && now - cached.at < PC_CACHE_TTL_MS) return { playing: cached.playing, maxPlayers: cached.maxPlayers };
  let cursor = null;
  for (let page = 0; page < PC_MAX_PAGES; page++) {
    let url = GAME_SERVERS_API.replace('%place%', encodeURIComponent(placeId)) + `?limit=100&sortOrder=Asc`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    let res;
    try {
      res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    } catch {
      return null;
    }
    if (res.status === 429) {
      const ra = res.headers.get('retry-after');
      const wait = Math.max(0, Number(ra) * 1000 || 0);
      if (page === 0 && wait) await new Promise(r => setTimeout(r, wait));
      else return null;
      res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    }
    if (!res.ok) return null;
    let data;
    try {
      data = await res.json();
    } catch {
      return null;
    }
    const list = data.data || [];
    const hit = list.find(s => s.id === serverId);
    if (hit) {
      const entry = { playing: Number.isFinite(hit.playing) ? hit.playing : null, maxPlayers: Number.isFinite(hit.maxPlayers) ? hit.maxPlayers : null, at: now };
      cacheSetLimited(pcCache, serverId, entry);
      return { playing: entry.playing, maxPlayers: entry.maxPlayers };
    }
    if (!data.nextPageCursor) return null;
    cursor = data.nextPageCursor;
    if (page < PC_MAX_PAGES - 1) await new Promise(r => setTimeout(r, PC_PAGE_DELAY_MS));
  }
  return null;
}
module.exports = {
  resolveUsernames,
  getPresences,
  getAvatars,
  getGameNames,
  getUniverseIdsFromPlaceIds,
  checkAuth,
  takeRefreshedCookie,
  getRovalraServerDetails,
  getServerPlayerCount,
  PRESENCE_LABEL,
  retryable,
  isDegraded,
  getHealth,
};
