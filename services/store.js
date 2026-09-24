const fs = require('fs');
const path = require('path');
const { validateUsername, validateChannel } = require('./validators');

const APP_VERSION = '2.5.6';
const STORAGE_VERSION = 2;
const DATA_DIR = path.resolve(process.env.ALICIA_DATA_DIR || path.join(__dirname, '..', 'data'));
const USERS_DIR = path.join(DATA_DIR, 'users');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const REMOVED_USERS_DIR = path.join(DATA_DIR, 'removed-users');
const TRANSACTIONS_DIR = path.join(DATA_DIR, '.transactions');
const MANIFEST_FILE = path.join(DATA_DIR, 'manifest.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'full-write.pending.json');
const LEGACY_FILE = path.join(DATA_DIR, 'state.json');
const LEGACY_GUILDS_FILE = path.join(DATA_DIR, 'guilds.json');
const GUILD_ID = String(process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || '').trim();
const MAX_TRACKERS_PER_GUILD = Math.max(1, Number(process.env.MAX_TRACKERS_PER_GUILD) || 50);
const MAX_ACCOUNTS_PER_GUILD = Math.max(1, Number(process.env.MAX_ACCOUNTS_PER_GUILD) || 25);
const LOG_SEGMENT_MAX_BYTES = Math.max(64 * 1024, Number(process.env.LOG_SEGMENT_MAX_BYTES) || 5 * 1024 * 1024);
const configuredHistoryLimit = Number(process.env.MAX_HISTORY_PER_USER);
const MAX_HISTORY_PER_USER = Number.isFinite(configuredHistoryLimit) && configuredHistoryLimit > 0 ? Math.floor(configuredHistoryLimit) : 0;
const FLUSH_DEBOUNCE_MS = 120;
const FLUSH_MIN_INTERVAL_MS = 500;
const FLUSH_MAX_RETRY_MS = 30000;

let cache = null;
let usersByKey = new Map();
let accountsById = new Map();
const userData = new Map();
let flushTimer = null;
let retryTimer = null;
let lastFlushAt = 0;
let flushFailures = 0;
let persistenceBlocked = false;
let lastErrorAt = 0;
let stateRevision = 0;
const dirty = { settings: false, accounts: false, users: new Map() };

function logStoreError(label, error) {
  const now = Date.now();
  if (now - lastErrorAt < 5000 && label !== 'read') return;
  lastErrorAt = now;
  console.error(`[store] ${label}: ${error?.message || error}`);
}

function defaultNotifications() {
  return { online: true, offline: true, gameJoin: true, gameChange: true, gameLeave: true };
}

function defaultSettings() {
  return {
    intervalMs: 15000,
    notifyChannelId: null,
    notifications: defaultNotifications(),
    tiktokWatch: [],
    tiktokChannelId: null,
    quiet: false,
    quietUntilMs: null,
    compactLinks: false,
    gameOnly: false,
    allyPing: false,
    serverInfo: false,
    tiktokLive: false,
    tiktokIntervalMs: 60000,
  };
}

function defaults() {
  return { settings: defaultSettings(), users: [], accounts: [], createdAt: new Date().toISOString() };
}

function normalizeNotifications(raw) {
  const output = {};
  for (const key of Object.keys(defaultNotifications())) {
    if (raw && typeof raw[key] === 'boolean') output[key] = raw[key];
  }
  return output;
}

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const settings = {
    ...defaultSettings(),
    ...value,
    notifications: { ...defaultNotifications(), ...(value.notifications || {}) },
    tiktokWatch: Array.isArray(value.tiktokWatch) ? value.tiktokWatch : [],
  };
  delete settings.userChannels;
  return settings;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeUsername(input) {
  const value = String(input == null ? '' : input).trim();
  if (!value || value.length > 100 || value === '.' || value === '..') return null;
  if (/[<>:"/\\|?*\u0000-\u001F]/u.test(value) || /[. ]$/u.test(value)) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) return null;
  return value;
}

function userDirectory(username) {
  const safe = safeUsername(username);
  if (!safe) throw new Error('A valid Roblox username is required for user storage.');
  return path.join(USERS_DIR, safe);
}

function ensureDir(directory, mode = 0o700) {
  fs.mkdirSync(directory, { recursive: true, mode });
  try { fs.chmodSync(directory, mode); } catch {}
}

function readJsonStrict(file, label = file) {
  recoverAtomicFile(file);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`Cannot read ${label}: ${error.message}`); }
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`Invalid JSON in ${label}: ${error.message}`); }
}

function readOptionalJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return readJsonStrict(file);
}

function recoverAtomicFile(file) {
  const recovery = `${file}.previous`;
  if (!fs.existsSync(recovery)) return;
  if (fs.existsSync(file)) fs.rmSync(recovery, { force: true });
  else fs.renameSync(recovery, file);
}

function storageFileExists(file) {
  return fs.existsSync(file) || fs.existsSync(`${file}.previous`);
}

function atomicWriteText(file, text) {
  ensureDir(path.dirname(file));
  recoverAtomicFile(file);
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  try { fs.renameSync(temporary, file); }
  catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    const recovery = `${file}.previous`;
    fs.rmSync(recovery, { force: true });
    fs.renameSync(file, recovery);
    try {
      fs.renameSync(temporary, file);
      fs.rmSync(recovery, { force: true });
    } catch (installError) {
      if (!fs.existsSync(file) && fs.existsSync(recovery)) fs.renameSync(recovery, file);
      throw installError;
    }
  }
}

function atomicWriteJson(file, value) {
  atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function mapValue(map, key) {
  if (!map || typeof map !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  const match = Object.keys(map).find(item => item.toLowerCase() === key.toLowerCase());
  return match ? map[match] : undefined;
}

function gameKey(event) {
  if (event?.placeId !== null && event?.placeId !== undefined && event?.placeId !== '') return `place:${event.placeId}`;
  if (event?.gameName) return `name:${String(event.gameName).toLowerCase()}`;
  return null;
}

function emptyGames(username) {
  return { schemaVersion: 1, username, updatedAt: null, games: {} };
}

function applyGameEvent(games, username, event) {
  const key = gameKey(event);
  if (!key) return;
  const at = event.at || new Date().toISOString();
  const existing = games.games[key] || {
    key,
    gameName: null,
    placeId: null,
    firstSeenAt: at,
    lastSeenAt: at,
    observations: 0,
    sessions: 0,
    joins: 0,
    changes: 0,
    leaves: 0,
  };
  existing.gameName = event.gameName || existing.gameName || null;
  existing.placeId = event.placeId ?? existing.placeId ?? null;
  existing.lastSeenAt = at;
  existing.observations++;
  if (event.eventType === 'gameJoin' || (event.eventType === 'initial' && event.inGame)) existing.sessions++;
  if (event.eventType === 'gameJoin') existing.joins++;
  if (event.eventType === 'gameChange') existing.changes++;
  if (event.eventType === 'gameLeave') existing.leaves++;
  games.games[key] = existing;
  games.updatedAt = at;
  games.username = username;
}

function normalizeGames(raw, username, history = []) {
  if (raw && typeof raw === 'object' && raw.games && typeof raw.games === 'object') {
    const source = Array.isArray(raw.games)
      ? Object.fromEntries(raw.games.filter(item => item?.key).map(item => [item.key, item]))
      : raw.games;
    return { schemaVersion: 1, username, updatedAt: raw.updatedAt || null, games: { ...source } };
  }
  const games = emptyGames(username);
  for (const event of history) applyGameEvent(games, username, event);
  return games;
}

function normalizeProfile(raw, index, legacyChannels) {
  const username = safeUsername(raw?.username);
  if (!username) throw new Error(`Backup contains an invalid username: ${raw?.username}`);
  const key = username.toLowerCase();
  return {
    id: raw?.id || makeId('track'),
    username,
    accountId: raw?.accountId || null,
    enabled: raw?.enabled !== false,
    notifications: normalizeNotifications(raw?.notifications),
    addedAt: raw?.addedAt || new Date().toISOString(),
    updatedAt: raw?.updatedAt || raw?.addedAt || new Date().toISOString(),
    tiktokHandle: raw?.tiktokHandle || null,
    channelId: raw?.channelId ?? legacyChannels?.[key] ?? null,
    order: Number.isFinite(Number(raw?.order)) ? Number(raw.order) : index,
  };
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object' || !String(raw.id || '').trim()) throw new Error('Backup contains an account without an id.');
  return {
    ...raw,
    id: String(raw.id),
    name: String(raw.name || 'Roblox account').trim() || 'Roblox account',
    cookie: String(raw.cookie || ''),
    enabled: raw.enabled !== false,
  };
}

function validateBackup(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Backup is not a JSON object.');
  if (Object.keys(parsed).some(key => /^\d+$/.test(key))) throw new Error('Backup contains a numeric character-index map and cannot be migrated safely.');
  if (parsed.storageVersion != null && Number(parsed.storageVersion) > STORAGE_VERSION) throw new Error(`Backup storage version ${parsed.storageVersion} is newer than supported version ${STORAGE_VERSION}.`);
  if (!Array.isArray(parsed.users)) throw new Error('Backup has no valid users array.');
  if (!Array.isArray(parsed.accounts)) throw new Error('Backup has no valid accounts array.');
  if (!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) throw new Error('Backup has no valid settings object.');
  const accountIds = new Set();
  for (const account of parsed.accounts) {
    const normalized = normalizeAccount(account);
    if (accountIds.has(normalized.id)) throw new Error(`Backup contains duplicate account id ${normalized.id}.`);
    accountIds.add(normalized.id);
  }
  const usernames = new Set();
  for (const user of parsed.users) {
    const normalized = normalizeProfile(user, 0, {});
    const key = normalized.username.toLowerCase();
    if (usernames.has(key)) throw new Error(`Backup contains duplicate username ${normalized.username}.`);
    usernames.add(key);
    if (normalized.accountId && !accountIds.has(normalized.accountId)) throw new Error(`${normalized.username} references a missing account.`);
  }
  return parsed;
}

function normalizeState(raw) {
  validateBackup(raw);
  const source = raw;
  const rawSettings = source.settings;
  const legacyChannels = rawSettings.userChannels && typeof rawSettings.userChannels === 'object' ? rawSettings.userChannels : {};
  const sourceUserData = source.userData && typeof source.userData === 'object' ? source.userData : {};
  const users = [];
  const history = {};
  const statuses = {};
  const errors = {};
  const games = {};
  source.users.forEach((rawUser, index) => {
    const profile = normalizeProfile(rawUser, index, legacyChannels);
    const key = profile.username.toLowerCase();
    const userData = mapValue(sourceUserData, key) || {};
    const sourceHistory = mapValue(source.history, key);
    const rows = Array.isArray(sourceHistory) ? sourceHistory : Array.isArray(userData.history) ? userData.history : [];
    const sourceErrors = mapValue(source.errors, key);
    const errorRows = Array.isArray(sourceErrors) ? sourceErrors : Array.isArray(userData.errors) ? userData.errors : [];
    history[key] = rows.slice();
    const status = mapValue(source.statuses, key) || userData.status || null;
    statuses[key] = status && typeof status === 'object' ? { ...status } : null;
    errors[key] = errorRows.slice();
    games[key] = normalizeGames(mapValue(source.games, key) || userData.games, profile.username, history[key]);
    users.push(profile);
  });
  users.sort((a, b) => a.order - b.order || String(a.addedAt).localeCompare(String(b.addedAt)));
  users.forEach((user, index) => { user.order = index; });
  return {
    settings: normalizeSettings(rawSettings),
    users,
    accounts: source.accounts.map(normalizeAccount),
    history,
    statuses,
    errors,
    games,
    createdAt: source.createdAt || new Date().toISOString(),
  };
}

function emptyUserData(username) {
  return {
    username,
    status: null,
    statusLoaded: false,
    history: [],
    historyLoaded: false,
    errors: [],
    errorsLoaded: false,
    games: emptyGames(username),
    gamesLoaded: false,
  };
}

function segmentFiles(directory, base) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => name !== `${base}.jsonl` && name.startsWith(`${base}.`) && name.endsWith('.jsonl'))
    .sort()
    .map(name => path.join(directory, name));
}

function parseJsonLine(line, file) {
  if (!line.trim()) return null;
  try { return JSON.parse(line); }
  catch (error) { logStoreError(`read ${path.basename(file)}`, error); return null; }
}

function readJsonLines(file) {
  recoverAtomicFile(file);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const row = parseJsonLine(line, file);
    if (row) rows.push(row);
  }
  return rows;
}

function utf8BoundaryStart(fd, start) {
  let position = start;
  const probe = Buffer.alloc(1);
  while (position > 0) {
    fs.readSync(fd, probe, 0, 1, position);
    if ((probe[0] & 0xc0) !== 0x80) break;
    position--;
  }
  return position;
}

function readLastJsonLines(file, limit) {
  recoverAtomicFile(file);
  if (!fs.existsSync(file) || limit <= 0) return [];
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const chunkSize = 64 * 1024;
    let position = size;
    let suffix = '';
    const newestFirst = [];
    while (position > 0 && newestFirst.length < limit) {
      const start = Math.max(0, position - chunkSize);
      const decodeStart = start > 0 ? utf8BoundaryStart(fd, start) : 0;
      const buffer = Buffer.alloc(position - decodeStart);
      fs.readSync(fd, buffer, 0, buffer.length, decodeStart);
      const lines = `${buffer.toString('utf8')}${suffix}`.split(/\r?\n/);
      suffix = start > 0 ? (lines.shift() || '') : '';
      for (let index = lines.length - 1; index >= 0 && newestFirst.length < limit; index--) {
        const row = parseJsonLine(lines[index], file);
        if (row) newestFirst.push(row);
      }
      position = start;
    }
    return newestFirst;
  } finally {
    fs.closeSync(fd);
  }
}

function readAllSegments(directory, base) {
  const files = [...segmentFiles(directory, base), path.join(directory, `${base}.jsonl`)];
  const rows = [];
  for (const file of files) rows.push(...readJsonLines(file));
  return rows;
}

function readTailSegments(directory, base, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return readAllSegments(directory, base);
  const files = [...segmentFiles(directory, base).reverse(), path.join(directory, `${base}.jsonl`)];
  const newestFirst = [];
  for (const file of files) {
    newestFirst.push(...readLastJsonLines(file, limit - newestFirst.length));
    if (newestFirst.length >= limit) break;
  }
  return newestFirst;
}

function writeJsonLines(file, rows) {
  const text = rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '';
  atomicWriteText(file, text);
}

function repairTrailingLine(file) {
  if (!fs.existsSync(file)) return;
  const fd = fs.openSync(file, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;
    let position = size;
    let lastNewline = -1;
    while (position > 0) {
      const start = Math.max(0, position - 64 * 1024);
      const buffer = Buffer.alloc(position - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const index = buffer.lastIndexOf(0x0a);
      if (index >= 0) {
        lastNewline = start + index;
        break;
      }
      position = start;
    }
    fs.ftruncateSync(fd, lastNewline + 1);
    logStoreError(`repair ${path.basename(file)}`, new Error('removed an incomplete trailing record'));
  } finally {
    fs.closeSync(fd);
  }
}

function appendJsonLines(file, rows) {
  if (!rows.length) return;
  ensureDir(path.dirname(file));
  repairTrailingLine(file);
  fs.appendFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
}

function rotateLogIfNeeded(file, base) {
  if (!fs.existsSync(file) || fs.statSync(file).size < LOG_SEGMENT_MAX_BYTES) return;
  const directory = path.dirname(file);
  const archive = path.join(directory, `${base}.${timestamp()}-${process.pid}.jsonl`);
  fs.renameSync(file, archive);
}

function publicUser(user) {
  const { order, ...value } = user;
  return { ...value, notifications: { ...user.notifications } };
}

function rebuildIndexes() {
  usersByKey = new Map(cache.users.map(user => [user.username.toLowerCase(), user]));
  accountsById = new Map(cache.accounts.map(account => [account.id, account]));
}

function readSplitIndex() {
  const manifest = readJsonStrict(MANIFEST_FILE, 'manifest.json');
  const version = Number(manifest.storageVersion);
  if (!Number.isFinite(version)) throw new Error('manifest.json has no valid storageVersion.');
  if (version > STORAGE_VERSION) throw new Error(`Storage version ${version} is newer than supported version ${STORAGE_VERSION}. Refusing to start to protect data.`);
  if (version !== STORAGE_VERSION) throw new Error(`Storage version ${version} requires a compatible migration. Refusing to start.`);
  const settings = normalizeSettings(readJsonStrict(SETTINGS_FILE, 'settings.json'));
  const accountsFile = readJsonStrict(ACCOUNTS_FILE, 'accounts.json');
  const accountsRaw = Array.isArray(accountsFile) ? accountsFile : accountsFile.accounts;
  if (!Array.isArray(accountsRaw)) throw new Error('accounts.json has no valid accounts array.');
  const accounts = accountsRaw.map(normalizeAccount);
  const accountIds = new Set();
  for (const account of accounts) {
    if (accountIds.has(account.id)) throw new Error(`Duplicate account id ${account.id} in accounts.json.`);
    accountIds.add(account.id);
  }
  if (!fs.existsSync(USERS_DIR)) throw new Error('users directory is missing.');
  const users = [];
  const seen = new Set();
  for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let directory = path.join(USERS_DIR, entry.name);
    let profilePath = path.join(directory, 'profile.json');
    if (!fs.existsSync(profilePath)) throw new Error(`Missing profile.json in users/${entry.name}.`);
    const profile = normalizeProfile(readJsonStrict(profilePath, `users/${entry.name}/profile.json`), users.length, {});
    const key = profile.username.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate user folder for ${profile.username}.`);
    if (profile.accountId && !accountIds.has(profile.accountId)) {
      profile.accountId = null;
      profile.enabled = false;
      profile.updatedAt = new Date().toISOString();
      atomicWriteJson(profilePath, profile);
    }
    if (path.basename(directory) !== profile.username) {
      const corrected = userDirectory(profile.username);
      const sameWindowsPath = process.platform === 'win32' && path.resolve(directory).toLowerCase() === path.resolve(corrected).toLowerCase();
      if (!sameWindowsPath) {
        if (fs.existsSync(corrected)) throw new Error(`Cannot reconcile duplicate folder for ${profile.username}.`);
        fs.renameSync(directory, corrected);
      }
    }
    seen.add(key);
    users.push(profile);
  }
  users.sort((a, b) => a.order - b.order || String(a.addedAt).localeCompare(String(b.addedAt)));
  users.forEach((user, index) => { user.order = index; });
  return { settings, users, accounts, createdAt: manifest.createdAt || users[0]?.addedAt || new Date().toISOString() };
}

function installState(state) {
  cache = state;
  userData.clear();
  rebuildIndexes();
  persistenceBlocked = false;
}

function findUser(state, username) {
  return state.users.find(user => user.username.toLowerCase() === String(username || '').trim().toLowerCase()) || null;
}

function loadUserField(username, field) {
  const user = findUser(cache, username);
  if (!user) return null;
  const key = user.username.toLowerCase();
  const data = userData.get(key) || emptyUserData(user.username);
  userData.set(key, data);
  const directory = userDirectory(user.username);
  if (field === 'status' && !data.statusLoaded) {
    const file = path.join(directory, 'status.json');
    data.status = fs.existsSync(file) ? readJsonStrict(file, `${user.username}/status.json`) : null;
    data.statusLoaded = true;
  }
  if (field === 'history' && !data.historyLoaded) {
    data.history = readAllSegments(directory, 'history');
    data.historyLoaded = true;
  }
  if (field === 'errors' && !data.errorsLoaded) {
    data.errors = readAllSegments(directory, 'errors');
    data.errorsLoaded = true;
  }
  if (field === 'games' && !data.gamesLoaded) {
    const file = path.join(directory, 'games.json');
    if (fs.existsSync(file)) data.games = normalizeGames(readJsonStrict(file, `${user.username}/games.json`), user.username);
    else {
      if (!data.historyLoaded) loadUserField(username, 'history');
      data.games = normalizeGames(null, user.username, data.history);
    }
    data.gamesLoaded = true;
  }
  return data;
}

function backupCurrentStorage(label) {
  if (!fs.existsSync(MANIFEST_FILE)) return null;
  ensureDir(BACKUPS_DIR);
  const target = path.join(BACKUPS_DIR, `${label}-${timestamp()}`);
  ensureDir(target);
  for (const file of [MANIFEST_FILE, SETTINGS_FILE, ACCOUNTS_FILE]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(target, path.basename(file)), fs.constants.COPYFILE_EXCL);
  }
  if (fs.existsSync(USERS_DIR)) copyDirectory(USERS_DIR, path.join(target, 'users'));
  return target;
}

function stageFullState(state, extra = {}) {
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const directory = path.join(TRANSACTIONS_DIR, id);
  ensureDir(directory);
  const stagedUsers = path.join(directory, 'users');
  ensureDir(stagedUsers);
  atomicWriteJson(path.join(directory, 'settings.json'), state.settings);
  atomicWriteJson(path.join(directory, 'accounts.json'), state.accounts);
  for (const user of state.users) {
    const key = user.username.toLowerCase();
    const userStage = path.join(stagedUsers, user.username);
    ensureDir(userStage);
    atomicWriteJson(path.join(userStage, 'profile.json'), user);
    atomicWriteJson(path.join(userStage, 'status.json'), state.statuses[key] || null);
    writeJsonLines(path.join(userStage, 'history.jsonl'), state.history[key] || []);
    atomicWriteJson(path.join(userStage, 'games.json'), state.games[key] || emptyGames(user.username));
    writeJsonLines(path.join(userStage, 'errors.jsonl'), state.errors[key] || []);
  }
  atomicWriteJson(path.join(directory, 'manifest.json'), {
    appVersion: APP_VERSION,
    storageVersion: STORAGE_VERSION,
    createdAt: state.createdAt,
    migratedAt: new Date().toISOString(),
    ...extra,
  });
  atomicWriteJson(JOURNAL_FILE, { id, phase: 'prepared', createdAt: new Date().toISOString() });
  return { id, directory };
}

function commitStagedTransaction(id) {
  const directory = path.join(TRANSACTIONS_DIR, id);
  const stagedUsers = path.join(directory, 'users');
  if (!fs.existsSync(path.join(directory, 'manifest.json'))) throw new Error(`Transaction ${id} is incomplete.`);
  if (fs.existsSync(stagedUsers)) {
    fs.rmSync(USERS_DIR, { recursive: true, force: true });
    fs.renameSync(stagedUsers, USERS_DIR);
  } else if (!fs.existsSync(USERS_DIR)) throw new Error(`Transaction ${id} has no staged or live users directory.`);
  atomicWriteText(SETTINGS_FILE, fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'));
  atomicWriteText(ACCOUNTS_FILE, fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8'));
  atomicWriteText(MANIFEST_FILE, fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  atomicWriteJson(JOURNAL_FILE, { id, phase: 'committed', committedAt: new Date().toISOString() });
  fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(JOURNAL_FILE, { force: true });
}

function recoverPendingTransaction() {
  if (!fs.existsSync(JOURNAL_FILE)) return;
  const journal = readJsonStrict(JOURNAL_FILE, 'full-write.pending.json');
  if (!journal.id) throw new Error('full-write.pending.json has no transaction id.');
  const id = String(journal.id);
  if (journal.phase === 'committed') {
    fs.rmSync(path.join(TRANSACTIONS_DIR, id), { recursive: true, force: true });
    fs.rmSync(JOURNAL_FILE, { force: true });
    return;
  }
  commitStagedTransaction(id);
}

function writeFullState(state, extra = {}, { backup = true } = {}) {
  if (backup) backupCurrentStorage(`pre-full-${APP_VERSION}`);
  const staged = stageFullState(state, extra);
  commitStagedTransaction(staged.id);
  return state;
}

function hasCurrentLayoutArtifacts() {
  return [MANIFEST_FILE, SETTINGS_FILE, ACCOUNTS_FILE].some(storageFileExists) || fs.existsSync(USERS_DIR);
}

function ensureLayout() {
  ensureDir(DATA_DIR);
  ensureDir(BACKUPS_DIR);
  ensureDir(REMOVED_USERS_DIR);
  ensureDir(TRANSACTIONS_DIR);
  recoverPendingTransaction();
  if (hasCurrentLayoutArtifacts()) {
    for (const file of [MANIFEST_FILE, SETTINGS_FILE, ACCOUNTS_FILE]) {
      if (!storageFileExists(file)) throw new Error(`Storage is incomplete: ${path.basename(file)} is missing. Refusing to initialize over existing data.`);
    }
    return;
  }
  if (fs.existsSync(LEGACY_FILE)) {
    const raw = readJsonStrict(LEGACY_FILE, 'state.json');
    validateBackup(raw);
    const normalized = normalizeState(raw);
    ensureDir(BACKUPS_DIR);
    fs.copyFileSync(LEGACY_FILE, path.join(BACKUPS_DIR, `state-before-v${APP_VERSION}-${timestamp()}.json`), fs.constants.COPYFILE_EXCL);
    writeFullState(normalized, { migratedFrom: 'state.json' }, { backup: false });
    fs.rmSync(LEGACY_FILE, { force: true });
    return;
  }
  if (fs.existsSync(LEGACY_GUILDS_FILE)) {
    const all = readJsonStrict(LEGACY_GUILDS_FILE, 'guilds.json');
    if (!GUILD_ID || !all?.[GUILD_ID]) throw new Error('Legacy guilds.json does not contain the configured Discord guild. Refusing destructive migration.');
    const normalized = normalizeState(all[GUILD_ID]);
    ensureDir(BACKUPS_DIR);
    fs.copyFileSync(LEGACY_GUILDS_FILE, path.join(BACKUPS_DIR, `guilds-before-v${APP_VERSION}-${timestamp()}.json`), fs.constants.COPYFILE_EXCL);
    writeFullState(normalized, { migratedFrom: 'guilds.json' }, { backup: false });
    return;
  }
  const normalized = normalizeState({ ...defaults(), settings: defaultSettings(), users: [], accounts: [], history: {} });
  writeFullState(normalized, { freshInstall: true }, { backup: false });
}

function read() {
  if (cache !== null) return cache;
  try {
    ensureLayout();
    installState(readSplitIndex());
  } catch (error) {
    persistenceBlocked = true;
    logStoreError('read', error);
    cache = defaults();
    usersByKey = new Map();
    accountsById = new Map();
    throw error;
  }
  return cache;
}

function emptyUserDirty() {
  return { username: '', profile: false, status: false, games: false, history: [], historyRewrite: false, errors: [], remove: false };
}

function markUser(username, patch) {
  const key = String(username || '').toLowerCase();
  const current = dirty.users.get(key) || emptyUserDirty();
  current.username = String(username || current.username || key);
  if (patch.profile) current.profile = true;
  if (patch.status) current.status = true;
  if (patch.games) current.games = true;
  if (patch.history) current.history.push(patch.history);
  if (patch.historyRewrite) current.historyRewrite = true;
  if (patch.errors) current.errors.push(patch.errors);
  if (patch.remove) current.remove = true;
  dirty.users.set(key, current);
}

function dirtyPending() {
  return dirty.settings || dirty.accounts || dirty.users.size > 0;
}

function resetDirty() {
  dirty.settings = false;
  dirty.accounts = false;
  dirty.users.clear();
  flushFailures = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry() {
  if (!dirtyPending() || persistenceBlocked || retryTimer) return;
  const delay = Math.min(FLUSH_MAX_RETRY_MS, 1000 * (2 ** Math.min(flushFailures - 1, 5)));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushNow();
  }, delay);
  if (retryTimer.unref) retryTimer.unref();
}

function scheduleFlush() {
  if (persistenceBlocked || flushTimer || cache === null) return;
  const wait = Math.max(FLUSH_DEBOUNCE_MS, (lastFlushAt + FLUSH_MIN_INTERVAL_MS) - Date.now());
  flushTimer = setTimeout(() => {
    flushTimer = null;
    lastFlushAt = Date.now();
    flushNow();
  }, wait);
  if (flushTimer.unref) flushTimer.unref();
}

function archiveUserDirectory(username) {
  const source = userDirectory(username);
  if (!fs.existsSync(source)) return;
  ensureDir(REMOVED_USERS_DIR);
  const target = path.join(REMOVED_USERS_DIR, `${path.basename(source)}-${Date.now()}`);
  fs.renameSync(source, target);
}

function completePendingRemoval(key) {
  const changes = dirty.users.get(key);
  if (!changes?.remove) return;
  archiveUserDirectory(changes.username || key);
  dirty.users.delete(key);
}

function flushUser(key, changes) {
  const user = findUser(cache, key);
  if (changes.remove) {
    archiveUserDirectory(changes.username || key);
    dirty.users.delete(key);
    return;
  }
  if (!user) return;
  const data = userData.get(key) || emptyUserData(user.username);
  userData.set(key, data);
  const directory = userDirectory(user.username);
  ensureDir(directory);
  if (changes.profile) {
    atomicWriteJson(path.join(directory, 'profile.json'), user);
    changes.profile = false;
  }
  if (changes.status) {
    atomicWriteJson(path.join(directory, 'status.json'), data.status);
    data.statusLoaded = true;
    changes.status = false;
  }
  if (changes.games) {
    atomicWriteJson(path.join(directory, 'games.json'), data.games);
    data.gamesLoaded = true;
    changes.games = false;
  }
  const historyFile = path.join(directory, 'history.jsonl');
  const errorFile = path.join(directory, 'errors.jsonl');
  if (changes.historyRewrite) {
    writeJsonLines(historyFile, data.history);
    changes.history = [];
    changes.historyRewrite = false;
  } else if (changes.history.length) {
    appendJsonLines(historyFile, changes.history);
    rotateLogIfNeeded(historyFile, 'history');
    changes.history = [];
  }
  if (changes.errors.length) {
    appendJsonLines(errorFile, changes.errors);
    rotateLogIfNeeded(errorFile, 'errors');
    changes.errors = [];
  }
  if (!changes.profile && !changes.status && !changes.games && !changes.historyRewrite && !changes.history.length && !changes.errors.length) dirty.users.delete(key);
}

function flushNow({ throwOnError = false } = {}) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (cache === null) return true;
  if (persistenceBlocked) {
    const error = new Error('Storage is blocked after a startup read failure.');
    if (throwOnError) throw error;
    return false;
  }
  try {
    if (dirty.settings) {
      atomicWriteJson(SETTINGS_FILE, cache.settings);
      dirty.settings = false;
    }
    if (dirty.accounts) {
      atomicWriteJson(ACCOUNTS_FILE, cache.accounts);
      dirty.accounts = false;
    }
    for (const [key, changes] of [...dirty.users]) flushUser(key, changes);
    flushFailures = 0;
    return true;
  } catch (error) {
    flushFailures++;
    logStoreError('write', error);
    scheduleRetry();
    if (throwOnError) throw error;
    return false;
  }
}

function commit(changes = {}) {
  if (persistenceBlocked) throw new Error('Storage is blocked after a startup read failure.');
  if (changes.revision !== false) stateRevision++;
  if (changes.settings) dirty.settings = true;
  if (changes.accounts) dirty.accounts = true;
  if (changes.user) markUser(changes.user, changes);
  scheduleFlush();
}

function commitFullState(normalized, extra = {}) {
  if (persistenceBlocked) throw new Error('Storage is blocked after a startup read failure.');
  flushNow({ throwOnError: true });
  try {
    writeFullState(normalized, extra);
  } catch (error) {
    persistenceBlocked = true;
    throw error;
  }
  stateRevision++;
  installState({
    settings: normalized.settings,
    users: normalized.users,
    accounts: normalized.accounts,
    createdAt: normalized.createdAt,
  });
  for (const user of normalized.users) {
    const key = user.username.toLowerCase();
    userData.set(key, {
      username: user.username,
      status: normalized.statuses[key] || null,
      statusLoaded: true,
      history: normalized.history[key] || [],
      historyLoaded: true,
      errors: normalized.errors[key] || [],
      errorsLoaded: true,
      games: normalized.games[key] || emptyGames(user.username),
      gamesLoaded: true,
    });
  }
  resetDirty();
  return normalized;
}

function assertReady() {
  if (!GUILD_ID) throw new Error('DISCORD_GUILD_ID is not configured. Alicia Tracker requires one Discord guild ID.');
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 10) return '••••••••';
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(18, Math.max(8, value.length - 8)))}${value.slice(-4)}`;
}

function sanitizeContext(value, depth = 0) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return typeof value === 'string' ? value.slice(0, 500) : value;
  if (depth >= 2) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 10).map(item => sanitizeContext(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 500);
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) output[key] = /cookie|token|secret|password|authorization/i.test(key) ? '[REDACTED]' : sanitizeContext(item, depth + 1);
  return output;
}

function sameValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function createStore() {
  assertReady();
  read();
  return {
    guildId: GUILD_ID,
    getRevision() {
      return stateRevision;
    },
    getUsers() {
      return read().users.map(publicUser);
    },
    findUser(username) {
      const user = usersByKey.get(String(username || '').trim().toLowerCase());
      return user ? publicUser(user) : null;
    },
    getNotificationPolicy(username, type) {
      const user = usersByKey.get(String(username || '').trim().toLowerCase());
      const globalValue = read().settings.notifications?.[type] !== false;
      if (user && Object.prototype.hasOwnProperty.call(user.notifications, type)) return { enabled: !!user.notifications[type], source: 'user' };
      return { enabled: globalValue, source: 'server' };
    },
    getNotificationPolicies(username) {
      const user = usersByKey.get(String(username || '').trim().toLowerCase());
      return Object.fromEntries(Object.keys(defaultNotifications()).map(type => {
        const policy = this.getNotificationPolicy(username, type);
        return [type, policy];
      }));
    },
    addUser(username, accountId = null) {
      username = validateUsername(username);
      const state = read();
      const key = username.toLowerCase();
      completePendingRemoval(key);
      if (usersByKey.has(key)) return { added: false, reason: 'duplicate', users: this.getUsers() };
      if (state.users.length >= MAX_TRACKERS_PER_GUILD) return { added: false, reason: 'limit', limit: MAX_TRACKERS_PER_GUILD, users: this.getUsers() };
      if (accountId && !accountsById.has(accountId)) throw new Error('The selected cookie account does not exist.');
      const now = new Date().toISOString();
      const user = { id: makeId('track'), username, accountId: accountId || null, enabled: true, notifications: {}, addedAt: now, updatedAt: now, tiktokHandle: null, channelId: null, order: state.users.length };
      state.users.push(user);
      usersByKey.set(key, user);
      userData.set(key, emptyUserData(username));
      commit({ user: username, profile: true, status: true, games: true });
      return { added: true, user: publicUser(user), users: this.getUsers() };
    },
    updateUser(username, patch) {
      const user = usersByKey.get(String(username || '').trim().toLowerCase());
      if (!user) return null;
      if (patch.accountId !== undefined && patch.accountId && !accountsById.has(patch.accountId)) throw new Error('The selected cookie account does not exist.');
      if (patch.enabled !== undefined) user.enabled = !!patch.enabled;
      if (patch.accountId !== undefined) user.accountId = patch.accountId || null;
      if (patch.notifications) user.notifications = normalizeNotifications({ ...user.notifications, ...patch.notifications });
      if (patch.tiktokHandle !== undefined) user.tiktokHandle = patch.tiktokHandle || null;
      user.updatedAt = new Date().toISOString();
      commit({ user: user.username, profile: true });
      return publicUser(user);
    },
    resetUserNotifications(username, type = null) {
      const user = usersByKey.get(String(username || '').trim().toLowerCase());
      if (!user) return null;
      if (type) {
        if (!Object.prototype.hasOwnProperty.call(defaultNotifications(), type)) throw new Error('Unknown notification type.');
        delete user.notifications[type];
      } else user.notifications = {};
      user.updatedAt = new Date().toISOString();
      commit({ user: user.username, profile: true });
      return publicUser(user);
    },
    renameUser(username, nextUsername) {
      const user = usersByKey.get(String(username || '').trim().toLowerCase());
      if (!user) return null;
      nextUsername = safeUsername(nextUsername);
      if (!nextUsername) throw new Error('The Roblox username cannot be used for storage.');
      const oldKey = user.username.toLowerCase();
      const newKey = nextUsername.toLowerCase();
      if (oldKey === newKey && user.username === nextUsername) return publicUser(user);
      if (usersByKey.has(newKey) && usersByKey.get(newKey).id !== user.id) throw new Error('A tracked user with that username already exists.');
      const pending = dirty.users.get(oldKey);
      if (pending && !pending.remove) flushUser(oldKey, pending);
      const oldDirectory = userDirectory(user.username);
      const newDirectory = userDirectory(nextUsername);
      const previousProfile = { ...user, notifications: { ...user.notifications } };
      user.username = nextUsername;
      user.updatedAt = new Date().toISOString();
      if (fs.existsSync(oldDirectory)) {
        atomicWriteJson(path.join(oldDirectory, 'profile.json'), user);
        const caseOnlyOnWindows = process.platform === 'win32' && oldDirectory.toLowerCase() === newDirectory.toLowerCase();
        if (path.resolve(oldDirectory) !== path.resolve(newDirectory) && !caseOnlyOnWindows) {
          if (fs.existsSync(newDirectory)) throw new Error('The destination user folder already exists.');
          try { fs.renameSync(oldDirectory, newDirectory); }
          catch (error) {
            Object.assign(user, previousProfile);
            atomicWriteJson(path.join(oldDirectory, 'profile.json'), user);
            throw error;
          }
        }
      }
      usersByKey.delete(oldKey);
      usersByKey.set(newKey, user);
      const data = userData.get(oldKey) || emptyUserData(user.username);
      data.username = nextUsername;
      if (data.games?.username) data.games.username = nextUsername;
      userData.delete(oldKey);
      userData.set(newKey, data);
      dirty.users.delete(oldKey);
      commit({ user: nextUsername, profile: true, status: true, games: true });
      return publicUser(user);
    },
    getTiktokHandle(username) {
      return usersByKey.get(String(username || '').trim().toLowerCase())?.tiktokHandle || null;
    },
    getTiktokWatch() {
      return [...read().settings.tiktokWatch];
    },
    addTiktokWatch(handle) {
      handle = String(handle || '').replace(/^@/, '').trim().toLowerCase();
      if (!/^[a-z0-9_]{2,24}$/.test(handle)) throw new Error('Invalid TikTok handle.');
      if (!read().settings.tiktokWatch.includes(handle)) read().settings.tiktokWatch.push(handle);
      commit({ settings: true });
      return handle;
    },
    removeTiktokWatch(handle) {
      handle = String(handle || '').replace(/^@/, '').trim().toLowerCase();
      read().settings.tiktokWatch = read().settings.tiktokWatch.filter(item => item !== handle);
      commit({ settings: true });
      return this.getTiktokWatch();
    },
    getTiktokChannel() {
      return read().settings.tiktokChannelId || null;
    },
    setTiktokChannel(channelId) {
      read().settings.tiktokChannelId = channelId ? String(channelId).trim() : null;
      commit({ settings: true });
    },
    removeUser(username) {
      const key = String(username || '').trim().toLowerCase();
      const user = usersByKey.get(key);
      if (!user) return { removed: false, users: this.getUsers() };
      completePendingRemoval(key);
      archiveUserDirectory(user.username);
      read().users = read().users.filter(item => item.id !== user.id);
      usersByKey.delete(key);
      userData.delete(key);
      commit({});
      return { removed: true, users: this.getUsers() };
    },
    getAccounts() {
      return read().accounts.map(account => ({ ...account }));
    },
    getAccount(accountId) {
      const account = accountsById.get(accountId);
      return account ? { ...account } : null;
    },
    getAccountMap() {
      return new Map(read().accounts.map(account => [account.id, { ...account }]));
    },
    getEnabledAccounts() {
      return read().accounts.filter(account => account.enabled !== false && account.cookie).map(account => ({ ...account }));
    },
    getPublicAccounts() {
      return this.getAccounts().map(account => ({ id: account.id, name: account.name, enabled: account.enabled !== false, createdAt: account.createdAt, updatedAt: account.updatedAt, hasCookie: !!account.cookie, cookieMasked: maskSecret(account.cookie), lastAuth: account.lastAuth || null, lastError: account.lastError || null }));
    },
    addAccount({ name, cookie, enabled = true }) {
      cookie = String(cookie || '').trim();
      if (!cookie) throw new Error('A Roblox .ROBLOSECURITY cookie is required.');
      if (read().accounts.length >= MAX_ACCOUNTS_PER_GUILD) throw new Error(`Cookie account limit reached (${MAX_ACCOUNTS_PER_GUILD}).`);
      const now = new Date().toISOString();
      const account = { id: makeId('rbx'), name: String(name || 'Roblox account').trim() || 'Roblox account', cookie, enabled: !!enabled, createdAt: now, updatedAt: now, lastAuth: null, lastError: null };
      read().accounts.push(account);
      accountsById.set(account.id, account);
      commit({ accounts: true });
      return { ...account };
    },
    updateAccount(accountId, patch, { revision = true } = {}) {
      const account = accountsById.get(accountId);
      if (!account) return null;
      const next = { ...account };
      if (patch.name !== undefined) next.name = String(patch.name || 'Roblox account').trim() || 'Roblox account';
      if (patch.cookie !== undefined && patch.cookie !== '') next.cookie = String(patch.cookie).trim();
      if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
      if (patch.lastAuth !== undefined) next.lastAuth = patch.lastAuth;
      if (patch.lastError !== undefined) next.lastError = patch.lastError;
      const changed = ['name', 'cookie', 'enabled', 'lastAuth', 'lastError'].some(key => !sameValue(next[key], account[key]));
      if (!changed) return { ...account };
      next.updatedAt = new Date().toISOString();
      Object.assign(account, next);
      commit({ accounts: true, revision });
      return { ...account };
    },
    removeAccount(accountId) {
      if (!accountsById.has(accountId)) return this.getAccounts();
      read().accounts = read().accounts.filter(account => account.id !== accountId);
      accountsById.delete(accountId);
      for (const user of read().users.filter(item => item.accountId === accountId)) {
        user.accountId = null;
        user.enabled = false;
        user.updatedAt = new Date().toISOString();
        markUser(user.username, { profile: true });
      }
      commit({ accounts: true });
      return this.getAccounts();
    },
    getHistory(username, limit = 50) {
      const key = String(username || '').trim().toLowerCase();
      const user = usersByKey.get(key);
      if (!user) return [];
      const directory = userDirectory(user.username);
      const requested = Number(limit);
      const data = userData.get(key);
      const capRows = rows => MAX_HISTORY_PER_USER > 0 ? rows.slice(-MAX_HISTORY_PER_USER) : rows;
      if (data?.historyLoaded) {
        const rows = capRows(data.history);
        return requested > 0 && Number.isFinite(requested) ? rows.slice(-requested).reverse() : rows.slice().reverse();
      }
      const coldRows = Number.isFinite(requested) && requested > 0
        ? readTailSegments(directory, 'history', requested)
        : capRows(readAllSegments(directory, 'history')).reverse();
      return coldRows;
    },
    appendHistory(username, event) {
      const user = usersByKey.get(String(username || '').trim().toLowerCase());
      if (!user) return;
      const data = loadUserField(user.username, 'history');
      loadUserField(user.username, 'games');
      const entry = { ...event, at: new Date().toISOString() };
      data.history.push(entry);
      applyGameEvent(data.games, user.username, entry);
      if (MAX_HISTORY_PER_USER > 0 && data.history.length > MAX_HISTORY_PER_USER) {
        data.history = data.history.slice(-MAX_HISTORY_PER_USER);
        commit({ user: user.username, historyRewrite: true, games: true, revision: false });
      } else {
        commit({ user: user.username, history: entry, games: true, revision: false });
      }
    },
    appendUserError(username, source, error, context = {}) {
      const user = usersByKey.get(String(username || '').trim().toLowerCase());
      if (!user) return;
      const data = loadUserField(user.username, 'errors');
      const entry = { at: new Date().toISOString(), source: String(source || 'tracker'), message: String(error?.message || error || 'Unknown error').slice(0, 2000), context: sanitizeContext(context) };
      data.errors.push(entry);
      commit({ user: user.username, errors: entry, revision: false });
    },
    getErrors(username, limit = 100) {
      const key = String(username || '').trim().toLowerCase();
      const user = usersByKey.get(key);
      if (!user) return [];
      const directory = userDirectory(user.username);
      const requested = Number(limit);
      const data = userData.get(key);
      if (data?.errorsLoaded) return requested > 0 && Number.isFinite(requested) ? data.errors.slice(-requested).reverse() : data.errors.slice().reverse();
      return Number.isFinite(requested) && requested > 0 ? readTailSegments(directory, 'errors', requested) : readAllSegments(directory, 'errors').reverse();
    },
    setUserStatus(username, status, { force = false } = {}) {
      const user = usersByKey.get(String(username || '').trim().toLowerCase());
      if (!user) return;
      const data = loadUserField(user.username, 'status');
      const next = { ...status, updatedAt: status?.updatedAt || new Date().toISOString() };
      if (!force && sameValue(data.status, next)) return;
      data.status = next;
      commit({ user: user.username, status: true, revision: false });
    },
    getUserStatus(username) {
      const data = loadUserField(username, 'status');
      return data?.status ? { ...data.status } : null;
    },
    getGames(username) {
      const data = loadUserField(username, 'games');
      return data ? JSON.parse(JSON.stringify(data.games)) : emptyGames(username);
    },
    getSettings() {
      return JSON.parse(JSON.stringify(read().settings));
    },
    setSettings(patch) {
      const { userChannels, ...values } = patch || {};
      read().settings = normalizeSettings({ ...read().settings, ...values });
      commit({ settings: true });
      return this.getSettings();
    },
    getAllyPing() { return !!read().settings.allyPing; },
    setAllyPing(enabled) { read().settings.allyPing = !!enabled; commit({ settings: true }); },
    getGameOnly() { return !!read().settings.gameOnly; },
    setGameOnly(enabled) { read().settings.gameOnly = !!enabled; commit({ settings: true }); },
    getServerInfo() { return !!read().settings.serverInfo; },
    setServerInfo(enabled) { read().settings.serverInfo = !!enabled; commit({ settings: true }); },
    getTiktokLive() { return !!read().settings.tiktokLive; },
    setTiktokLive(enabled) { read().settings.tiktokLive = !!enabled; commit({ settings: true }); },
    getTiktokPoint() { return read().settings.tiktokIntervalMs || 60000; },
    setTiktokPoint(ms) { read().settings.tiktokIntervalMs = Math.max(10000, Number(ms) || 60000); commit({ settings: true }); },
    getQuiet() {
      const settings = read().settings;
      if (!settings.quiet) return false;
      if (settings.quietUntilMs && Date.now() > settings.quietUntilMs) {
        settings.quiet = false;
        settings.quietUntilMs = null;
        commit({ settings: true, revision: false });
        return false;
      }
      return true;
    },
    setQuiet(enabled, minutes) {
      const settings = read().settings;
      settings.quiet = !!enabled;
      settings.quietUntilMs = enabled && minutes > 0 ? Date.now() + Math.round(minutes * 60 * 1000) : null;
      commit({ settings: true });
    },
    getCompactLinks() { return !!read().settings.compactLinks; },
    setCompactLinks(enabled) { read().settings.compactLinks = !!enabled; commit({ settings: true }); },
    exportState() {
      const state = read();
      const history = {};
      const statuses = {};
      const errors = {};
      const games = {};
      for (const user of state.users) {
        const key = user.username.toLowerCase();
        const data = loadUserField(user.username, 'history');
        loadUserField(user.username, 'status');
        loadUserField(user.username, 'errors');
        loadUserField(user.username, 'games');
        history[key] = data.history.slice();
        statuses[key] = data.status ? { ...data.status } : null;
        errors[key] = data.errors.slice();
        games[key] = JSON.parse(JSON.stringify(data.games));
      }
      return JSON.parse(JSON.stringify({ format: 'alicia-tracker', appVersion: APP_VERSION, storageVersion: STORAGE_VERSION, exportedAt: new Date().toISOString(), settings: { ...state.settings, userChannels: this.getUserChannels() }, users: state.users.map(publicUser), accounts: state.accounts, history, statuses, errors, games, createdAt: state.createdAt }));
    },
    exportJson() {
      return `${JSON.stringify(this.exportState(), null, 2)}\n`;
    },
    importState(raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return commitFullState(normalizeState(validateBackup(parsed)), { importedAt: new Date().toISOString() });
    },
    setUserChannel(username, channelId) {
      const user = usersByKey.get(String(username || '').trim().toLowerCase());
      if (!user) throw new Error('The tracked user does not exist.');
      if (channelId) channelId = validateChannel(channelId);
      user.channelId = channelId ? String(channelId).trim() : null;
      user.updatedAt = new Date().toISOString();
      commit({ user: user.username, profile: true });
      return this.getUserChannels();
    },
    getUserChannel(username) {
      return usersByKey.get(String(username || '').trim().toLowerCase())?.channelId || null;
    },
    getUserChannels() {
      return Object.fromEntries(read().users.filter(user => user.channelId).map(user => [user.username.toLowerCase(), user.channelId]));
    },
    getPublicStats() {
      const state = read();
      return { users: state.users.length, accounts: state.accounts.length, createdAt: state.createdAt, maxTrackers: MAX_TRACKERS_PER_GUILD, maxAccounts: MAX_ACCOUNTS_PER_GUILD, maxHistoryPerUser: MAX_HISTORY_PER_USER || null };
    },
    searchUsers(query, limit = 20) {
      const value = String(query || '').trim().toLowerCase();
      if (!value) return [];
      return this.getUsers().filter(user => user.username.toLowerCase().includes(value)).slice(0, limit);
    },
    flush() {
      return flushNow();
    },
    flushOrThrow() {
      return flushNow({ throwOnError: true });
    },
    reset() {
      const normalized = normalizeState({ ...defaults(), settings: defaultSettings(), users: [], accounts: [], history: {} });
      commitFullState(normalized, { resetAt: new Date().toISOString() });
      return this.getPublicStats();
    },
  };
}

process.once('beforeExit', () => { try { flushNow(); } catch {} });
process.once('SIGINT', () => { try { flushNow({ throwOnError: true }); } catch {} });
process.once('SIGTERM', () => { try { flushNow({ throwOnError: true }); } catch {} });

module.exports = {
  createStore,
  createGuildStore: createStore,
  maskSecret,
  appVersion: APP_VERSION,
  storageVersion: STORAGE_VERSION,
  logSegmentMaxBytes: LOG_SEGMENT_MAX_BYTES,
  limits: { MAX_TRACKERS_PER_GUILD, MAX_ACCOUNTS_PER_GUILD, MAX_HISTORY_PER_USER },
};
