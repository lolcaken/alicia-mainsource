// services/tiktok.js
// EXPERIMENTAL TikTok LIVE tracker. Off by default — enabled via
// `/settings tiktok on`. Detects whether a TikTok @handle is currently live
// using the same endpoints the RSSHub route uses (api-live/user/room pulse +
// webcast room check_alive), with a UA header and request timeout.
// This is unofficial scraping, not a TikTok API product — treat results as
// best-effort and keep the poll interval polite.
const TIKTOK_BASE = 'https://www.tiktok.com';
const WEBCAST_BASE = 'https://webcast.tiktok.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TIMEOUT_MS = Math.max(5000, Number(process.env.TIKTOK_TIMEOUT_MS) || 10000);
const CACHE_TTL_MS = Math.max(10000, Number(process.env.TIKTOK_CACHE_MS) || 20 * 1000);

const cache = new Map(); // handle -> { live, roomId, title, nickname, avatar, at }

async function fetchWithTimeout(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Returns { data } or null. The presence of data.user.uniqueId confirms the
// account exists; data.user.roomId is set when a room exists (live OR ended).
async function getRoomInfo(handle) {
  const params = new URLSearchParams({ aid: '1988', sourceType: '54', uniqueId: handle });
  const res = await fetchWithTimeout(`${TIKTOK_BASE}/api-live/user/room/?${params}`);
  if (!res.ok) throw new Error(`TikTok room API responded ${res.status}`);
  const json = await res.json();
  if (json.statusCode === 19881007 || !json.data) return { user: null, liveRoom: null }; // user_not_found
  return json.data;
}

// Authoritative alive check for a room id. Returns true/false, or null if the
// response is unparseable (caller treats null like 'unknown', never 'offline').
async function checkAlive(roomId) {
  const params = new URLSearchParams({ aid: '1988', room_ids: String(roomId) });
  const res = await fetchWithTimeout(`${WEBCAST_BASE}/webcast/room/check_alive/?${params}`);
  if (!res.ok) return null;
  const json = await res.json();
  const row = Array.isArray(json.data) ? json.data[0] : null;
  return row && typeof row.alive === 'boolean' ? row.alive : null;
}

// Single combined lookup for one handle. Returns a normalized status object:
//   { live: bool, unknown: bool, roomId, title, nickname, avatar }
// Tradeoffs like the RSSHub implementation: an existing room is only reported
// as LIVE when check_alive confirms it; anything uncertain -> unknown:true so
// callers never fire a false "went live"/"ended" off an API hiccup.
async function getLiveStatus(handle) {
  const now = Date.now();
  const cached = cache.get(handle);
  if (cached && now - cached.at < CACHE_TTL_MS) return { ...cached };

  let roomInfo;
  try {
    roomInfo = await getRoomInfo(handle);
  } catch (err) {
    const c = cache.get(handle);
    if (c) return { ...c, unknown: true };
    return { live: false, unknown: true, roomId: null, title: null, nickname: handle, avatar: null };
  }

  const user = roomInfo.user;
  if (!user) {
    cache.set(handle, { live: false, unknown: false, roomId: null, title: null, nickname: handle, avatar: null, at: now });
    return { live: false, unknown: false, roomId: null, title: null, nickname: handle, avatar: null };
  }

  const roomId = user.roomId || null;
  const nickname = user.nickname || handle;
  const avatar = user.avatarLarger || user.avatarMedium || user.avatarThumb || null;
  const roomTitle = roomInfo.liveRoom?.title || null;

  if (!roomId) {
    cache.set(handle, { live: false, unknown: false, roomId: null, title: null, nickname, avatar, at: now });
    return { live: false, unknown: false, roomId: null, title: null, nickname, avatar };
  }

  let alive = null;
  try { alive = await checkAlive(roomId); } catch {}
  const status = {
    live: alive === true,
    unknown: alive === null,
    roomId,
    title: roomTitle || null,
    nickname,
    avatar,
  };
  cache.set(handle, { ...status, at: now });
  return status;
}

// Politeness guard: never leave N room checks punching TikTok at once.
async function checkMany(handles, concurrency = 2) {
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < handles.length) {
      const h = handles[next++];
      try { out.push([h, await getLiveStatus(h)]); } catch { out.push([h, null]); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, handles.length)) }, worker));
  return out;
}

module.exports = { getLiveStatus, checkMany, getRoomInfo, checkAlive };