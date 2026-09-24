const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

// Set env before any requires that cache module-level constants
process.env.DISCORD_GUILD_ID = '123456789012345678';
process.env.DISCORD_BOT_TOKEN = 'fake-token-for-test';
process.env.LOG_SEGMENT_MAX_BYTES = '65536';
process.env.STATUS_HEARTBEAT_MS = '15000';

const root = path.join(__dirname, '..');
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alicia-store-'));
process.env.ALICIA_DATA_DIR = testDataDir;
const files = [
  'config.js',
  'bot/commands.js',
  'services/tracker.js',
  'services/store.js',
  'services/settings.js',
  'services/roblox.js',
  'services/notifier.js',
  'services/discord.js',
  'services/validators.js',
  'services/tiktok.js',
];

for (const file of files) {
  try {
    require(path.join(root, file));
  } catch (err) {
    // If it's just missing env var for store assertReady or Discord Client, that's fine
    if (!err.message.includes('DISCORD_GUILD_ID is not configured')) {
      throw err;
    }
  }
}
console.log('[check] All files parsed cleanly.');

// 2. Test validators
const { validateUsername, validateChannel } = require('../services/validators');
assert.strictEqual(validateUsername('Builderman'), 'Builderman');
assert.strictEqual(validateUsername('Ølizxq7'), 'Ølizxq7');
assert.throws(() => validateUsername(''), /required/);
assert.throws(() => validateUsername('a'.repeat(21)), /20 characters/);
assert.throws(() => validateUsername('bad$char'), /characters Roblox does not allow/);
assert.strictEqual(validateChannel('123456789012345678'), '123456789012345678');
assert.throws(() => validateChannel('not-a-channel'), /channel id/);
console.log('[check] Validators passed.');

// 3. Test store in isolation
process.env.DISCORD_GUILD_ID = '123456789012345678';
const { createStore } = require('../services/store');
const testStore = createStore();
assert.strictEqual(testStore.addUser('testUser').added, true);
testStore.setUserChannel('testUser', '987654321098765432');
assert.strictEqual(testStore.getUserChannel('testUser'), '987654321098765432');
assert.strictEqual(testStore.getUserChannel('TESTUSER'), '987654321098765432');
testStore.setUserChannel('testUser', null);
assert.strictEqual(testStore.getUserChannel('testUser'), null);
console.log('[check] Store user-channel operations passed.');

// 3b. Hot-path regression: repeated reads must come from an in-memory cache,
// not a full synchronous file read + parse on every access (that blocks the
// event loop and starves Discord's 3s autocomplete window during poll bursts).
(async () => {
  const freshStore = createStore();
  const origRead = fs.readFileSync;
  freshStore.getUsers();
  freshStore.getSettings();
  let reads = 0;
  fs.readFileSync = function (...a) { reads++; return origRead.apply(this, a); };
  try {
    for (let i = 0; i < 200; i++) freshStore.getUsers();
    for (let i = 0; i < 200; i++) freshStore.getSettings();
    for (let i = 0; i < 200; i++) freshStore.getUserChannel('testUser');
    for (let i = 0; i < 200; i++) freshStore.getQuiet();
  } finally {
    fs.readFileSync = origRead;
  }
  assert.strictEqual(reads, 0, 'store must serve reads from an in-memory cache, not re-read the file');

  // 3c. Despite the cache, writes must still reach disk (bounded flush) so state
  // survives a restart.
  freshStore.setQuiet(true, 10);
  freshStore.setCompactLinks(true);
  assert.strictEqual(freshStore.addUser('cacheUser').added, true);
  freshStore.setUserChannel('cacheUser', '111111111111111111');
  freshStore.setUserStatus('cacheUser', { username: 'cacheUser', status: 'Online', inGame: false });
  freshStore.appendUserError('cacheUser', 'test', 'test failure', { stage: 'test', cookie: 'SECRET_COOKIE' });
  assert.strictEqual(freshStore.addUser('historyProbe').added, true);
  for (let i = 0; i < 150; i++) freshStore.appendHistory('historyProbe', { eventType: 'status', status: 'Online', inGame: false });
  freshStore.flush();
  const renamed = freshStore.renameUser('cacheUser', 'cacheUserRenamed');
  assert.strictEqual(renamed.username, 'cacheUserRenamed');
  freshStore.flush();

  const settings = JSON.parse(fs.readFileSync(path.join(testDataDir, 'settings.json'), 'utf8'));
  const renamedDir = path.join(testDataDir, 'users', 'cacheUserRenamed');
  const profile = JSON.parse(fs.readFileSync(path.join(renamedDir, 'profile.json'), 'utf8'));
  const errors = fs.readFileSync(path.join(renamedDir, 'errors.jsonl'), 'utf8');
  const historyLines = fs.readFileSync(path.join(testDataDir, 'users', 'historyProbe', 'history.jsonl'), 'utf8').trim().split(/\r?\n/);
  assert.strictEqual(settings.quiet, true, 'quiet change must flush to disk');
  assert.strictEqual(settings.compactLinks, true, 'compact links change must flush to disk');
  assert.strictEqual(profile.channelId, '111111111111111111', 'user channel must live in profile.json');
  assert(!fs.existsSync(path.join(testDataDir, 'users', 'cacheUser')), 'old username folder must be removed');
  assert(errors.includes('[REDACTED]') && !errors.includes('SECRET_COOKIE'), 'user error logs must redact secrets');
  assert.strictEqual(historyLines.length, 150, 'history must be unlimited by default');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(testDataDir, 'users', 'historyProbe', 'games.json'), 'utf8')).schemaVersion, 1);

  assert.deepStrictEqual(freshStore.findUser('testUser').notifications, {});
  freshStore.setSettings({ notifications: { ...freshStore.getSettings().notifications, gameLeave: false } });
  assert.deepStrictEqual(freshStore.getNotificationPolicy('testUser', 'gameLeave'), { enabled: false, source: 'server' });
  freshStore.updateUser('testUser', { notifications: { gameLeave: true } });
  assert.deepStrictEqual(freshStore.getNotificationPolicy('testUser', 'gameLeave'), { enabled: true, source: 'user' });
  freshStore.resetUserNotifications('testUser', 'gameLeave');
  assert.deepStrictEqual(freshStore.getNotificationPolicy('testUser', 'gameLeave'), { enabled: false, source: 'server' });
  freshStore.resetUserNotifications('testUser');
  const revisionBeforeStatus = freshStore.getRevision();
  freshStore.setUserStatus('testUser', { username: 'testUser', status: 'Online', inGame: false });
  assert.strictEqual(freshStore.getRevision(), revisionBeforeStatus, 'status writes must not invalidate in-flight polls');
  freshStore.updateUser('testUser', { enabled: true });
  assert(freshStore.getRevision() > revisionBeforeStatus, 'profile changes must invalidate in-flight polls');
  freshStore.flush();

  freshStore.removeUser('historyProbe');
  freshStore.addUser('historyProbe');
  freshStore.appendHistory('historyProbe', { eventType: 'gameJoin', status: 'In Game', gameName: 'Pending Game', placeId: 456, inGame: true });
  freshStore.renameUser('historyProbe', 'historyProbeRenamed');
  freshStore.flush();
  assert(fs.existsSync(path.join(testDataDir, 'users', 'historyProbeRenamed', 'profile.json')));
  assert(fs.readFileSync(path.join(testDataDir, 'users', 'historyProbeRenamed', 'history.jsonl'), 'utf8').includes('Pending Game'));

  freshStore.addUser('segmentProbe');
  for (let i = 0; i < 800; i++) freshStore.appendHistory('segmentProbe', { eventType: 'status', status: 'Online', inGame: false, filler: 'x'.repeat(120) });
  freshStore.flush();
  const segmentFiles = fs.readdirSync(path.join(testDataDir, 'users', 'segmentProbe')).filter(file => /^history\..+\.jsonl$/.test(file));
  assert(segmentFiles.length > 0, 'large history must rotate into archive segments');
  assert.strictEqual(freshStore.getHistory('segmentProbe', 3).length, 3);
  assert.strictEqual(freshStore.getHistory('segmentProbe', 0).length, 800);

  freshStore.addUser('RemovalUser');
  freshStore.flush();
  freshStore.removeUser('RemovalUser');
  const removalRestartScript = `const s=require(${JSON.stringify(path.join(root, 'services', 'store.js'))}).createStore(); if(s.findUser('RemovalUser'))process.exit(2); if(s.getHistory('segmentProbe',0).length!==800)process.exit(3);`;
  childProcess.execFileSync(process.execPath, ['-e', removalRestartScript], {
    env: { ...process.env, ALICIA_DATA_DIR: testDataDir, DISCORD_GUILD_ID: '123456789012345678' },
    stdio: 'ignore',
  });
  freshStore.flush();
  assert(!fs.existsSync(path.join(testDataDir, 'users', 'RemovalUser')), 'removed user folder must leave active storage');
  assert(fs.readdirSync(path.join(testDataDir, 'removed-users')).some(name => name.startsWith('RemovalUser-')), 'removed user data must be archived');

  assert.throws(() => freshStore.importState({}), /users/i);
  assert(fs.existsSync(path.join(testDataDir, 'users', 'segmentProbe', 'profile.json')), 'invalid import must not mutate live data');

  const transactionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alicia-transaction-'));
  const transactionData = path.join(transactionRoot, 'data');
  const importPayload = JSON.stringify({ settings: { notifications: {} }, users: [{ id: 'imported', username: 'ImportedUser', notifications: {}, accountId: null, enabled: true }], accounts: [], history: { importeduser: [{ eventType: 'initial', status: 'Online', inGame: false, at: new Date().toISOString() }] } });
  const importScript = `const s=require(${JSON.stringify(path.join(root, 'services', 'store.js'))}).createStore(); s.importState(${JSON.stringify(importPayload)});`;
  childProcess.execFileSync(process.execPath, ['-e', importScript], {
    env: { ...process.env, ALICIA_DATA_DIR: transactionData, DISCORD_GUILD_ID: '123456789012345678' },
    stdio: 'ignore',
  });
  assert(fs.existsSync(path.join(transactionData, 'users', 'ImportedUser', 'profile.json')), 'valid import must commit staged user data');
  assert(fs.readdirSync(path.join(transactionData, 'backups')).some(name => name.startsWith('pre-full-2.5.6-')), 'valid import must create pre-write backup');
  assert(!fs.existsSync(path.join(transactionData, 'full-write.pending.json')), 'successful import must clear transaction journal');
  fs.rmSync(transactionRoot, { recursive: true, force: true });

  const lazyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alicia-lazy-'));
  const lazyData = path.join(lazyRoot, 'data');
  const lazyUsers = Array.from({ length: 20 }, (_, index) => ({ id: `lazy_${index}`, username: `LazyUser${index}`, notifications: {}, accountId: null, enabled: true }));
  const lazyHistory = Object.fromEntries(lazyUsers.map((user, index) => [user.username.toLowerCase(), Array.from({ length: 50 }, (_, event) => ({ eventType: 'status', status: 'Online', inGame: false, at: new Date(1700000000000 + index * 100000 + event * 1000).toISOString() }))]));
  const lazyPayload = path.join(lazyRoot, 'payload.json');
  fs.writeFileSync(lazyPayload, JSON.stringify({ settings: { notifications: {} }, users: lazyUsers, accounts: [], history: lazyHistory }));
  const lazyImportScript = `const fs=require('fs'); const s=require(${JSON.stringify(path.join(root, 'services', 'store.js'))}).createStore(); s.importState(fs.readFileSync(${JSON.stringify(lazyPayload)},'utf8'));`;
  childProcess.execFileSync(process.execPath, ['-e', lazyImportScript], {
    env: { ...process.env, ALICIA_DATA_DIR: lazyData, DISCORD_GUILD_ID: '123456789012345678' },
    stdio: 'ignore',
  });
  const lazyReadScript = `const fs=require('fs'); const m=require(${JSON.stringify(path.join(root, 'services', 'store.js'))}); const originalRead=fs.readFileSync; const originalReadSync=fs.readSync; let reads=0; fs.readFileSync=(...args)=>{reads++;return originalRead(...args)}; fs.readSync=(...args)=>{reads++;return originalReadSync(...args)}; const s=m.createStore(); const before=reads; s.getHistory('LazyUser0',1); process.stdout.write(JSON.stringify({before,after:reads}));`;
  const lazyReads = JSON.parse(childProcess.execFileSync(process.execPath, ['-e', lazyReadScript], {
    env: { ...process.env, ALICIA_DATA_DIR: lazyData, DISCORD_GUILD_ID: '123456789012345678' },
    encoding: 'utf8',
  }));
  assert(lazyReads.before <= 50, 'startup must not read every per-user data file');
  assert(lazyReads.after > lazyReads.before, 'history access must lazy-load the requested log');
  fs.rmSync(lazyRoot, { recursive: true, force: true });

  const migrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alicia-migration-'));
  const migrationData = path.join(migrationRoot, 'data');
  fs.mkdirSync(migrationData, { recursive: true });
  fs.writeFileSync(path.join(migrationData, 'state.json'), JSON.stringify({
    settings: { notifyChannelId: '1552693686872186930', userChannels: { ølizxq7: '1545492658800296037' } },
    users: [{ id: 'track_legacy', username: 'Ølizxq7', accountId: null, enabled: true, notifications: {}, addedAt: '2026-01-01T00:00:00.000Z' }],
    accounts: [],
    history: { ølizxq7: [{ eventType: 'gameJoin', status: 'In Game', gameName: 'Legacy Game', placeId: 123, inGame: true, at: '2026-01-01T00:01:00.000Z' }] },
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  const migrationScript = `require(${JSON.stringify(path.join(root, 'services', 'store.js'))}).createStore().getUsers();`;
  childProcess.execFileSync(process.execPath, ['-e', migrationScript], {
    env: { ...process.env, ALICIA_DATA_DIR: migrationData, DISCORD_GUILD_ID: '123456789012345678' },
    stdio: 'ignore',
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(migrationData, 'manifest.json'), 'utf8'));
  const migratedProfile = JSON.parse(fs.readFileSync(path.join(migrationData, 'users', 'Ølizxq7', 'profile.json'), 'utf8'));
  const migratedHistory = fs.readFileSync(path.join(migrationData, 'users', 'Ølizxq7', 'history.jsonl'), 'utf8').trim();
  const migratedGames = JSON.parse(fs.readFileSync(path.join(migrationData, 'users', 'Ølizxq7', 'games.json'), 'utf8'));
  assert.strictEqual(manifest.storageVersion, 2);
  assert.strictEqual(migratedProfile.channelId, '1545492658800296037');
  assert(migratedHistory.includes('Legacy Game'));
  assert(Object.values(migratedGames.games).some(game => game.gameName === 'Legacy Game'));
  assert(!fs.existsSync(path.join(migrationData, 'state.json')), 'legacy state.json must leave runtime after migration');
  assert(fs.readdirSync(path.join(migrationData, 'backups')).some(file => file.includes('before-v2.5.6')), 'legacy state backup missing');
  fs.rmSync(migrationRoot, { recursive: true, force: true });

  const futureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alicia-future-'));
  const futureData = path.join(futureRoot, 'data');
  fs.mkdirSync(path.join(futureData, 'users'), { recursive: true });
  fs.writeFileSync(path.join(futureData, 'manifest.json'), JSON.stringify({ appVersion: '9.0.0', storageVersion: 999, createdAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(futureData, 'settings.json'), '{}');
  fs.writeFileSync(path.join(futureData, 'accounts.json'), '[]');
  const futureResult = childProcess.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(root, 'services', 'store.js'))}).createStore();`], {
    env: { ...process.env, ALICIA_DATA_DIR: futureData, DISCORD_GUILD_ID: '123456789012345678' },
    encoding: 'utf8',
  });
  assert.notStrictEqual(futureResult.status, 0, 'future storage version must refuse startup');
  assert(fs.existsSync(path.join(futureData, 'manifest.json')), 'future storage files must remain untouched');
  fs.rmSync(futureRoot, { recursive: true, force: true });

  const numericRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alicia-numeric-'));
  const numericData = path.join(numericRoot, 'data');
  fs.mkdirSync(numericData, { recursive: true });
  fs.writeFileSync(path.join(numericData, 'state.json'), JSON.stringify({ 0: '{', 1: '"', settings: {}, users: [], accounts: [], history: {} }));
  const numericStoreScript = `require(${JSON.stringify(path.join(root, 'services', 'store.js'))}).createStore();`;
  const numericResult = childProcess.spawnSync(process.execPath, ['-e', numericStoreScript], {
    env: { ...process.env, ALICIA_DATA_DIR: numericData, DISCORD_GUILD_ID: '123456789012345678' },
    encoding: 'utf8',
  });
  assert.notStrictEqual(numericResult.status, 0, 'numeric character-index legacy maps must be rejected');
  assert(fs.existsSync(path.join(numericData, 'state.json')), 'rejected legacy map must remain untouched');
  fs.rmSync(numericRoot, { recursive: true, force: true });

  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alicia-recovery-'));
  const recoveryData = path.join(recoveryRoot, 'data');
  const createStoreScript = `require(${JSON.stringify(path.join(root, 'services', 'store.js'))}).createStore();`;
  childProcess.execFileSync(process.execPath, ['-e', createStoreScript], {
    env: { ...process.env, ALICIA_DATA_DIR: recoveryData, DISCORD_GUILD_ID: '123456789012345678' },
    stdio: 'ignore',
  });
  const recoverySettings = path.join(recoveryData, 'settings.json');
  fs.renameSync(recoverySettings, `${recoverySettings}.previous`);
  childProcess.execFileSync(process.execPath, ['-e', createStoreScript], {
    env: { ...process.env, ALICIA_DATA_DIR: recoveryData, DISCORD_GUILD_ID: '123456789012345678' },
    stdio: 'ignore',
  });
  assert(fs.existsSync(recoverySettings), 'atomic replacement recovery must restore a missing primary file');
  fs.writeFileSync(path.join(recoveryData, 'full-write.pending.json'), JSON.stringify({ id: 'already-removed', phase: 'committed' }));
  childProcess.execFileSync(process.execPath, ['-e', createStoreScript], {
    env: { ...process.env, ALICIA_DATA_DIR: recoveryData, DISCORD_GUILD_ID: '123456789012345678' },
    stdio: 'ignore',
  });
  assert(!fs.existsSync(path.join(recoveryData, 'full-write.pending.json')), 'committed transaction journal must self-clean');
  fs.rmSync(recoveryRoot, { recursive: true, force: true });

  const capRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alicia-cap-'));
  const capData = path.join(capRoot, 'data');
  const capScript = `const s=require(${JSON.stringify(path.join(root, 'services', 'store.js'))}).createStore(); s.addUser('CapUser'); for(let i=0;i<30;i++)s.appendHistory('CapUser',{eventType:'status',status:'Online'}); s.flush(); s.flush(); if(s.getHistory('CapUser',0).length!==25)process.exit(2);`;
  childProcess.execFileSync(process.execPath, ['-e', capScript], {
    env: { ...process.env, ALICIA_DATA_DIR: capData, DISCORD_GUILD_ID: '123456789012345678', MAX_HISTORY_PER_USER: '25' },
    stdio: 'ignore',
  });
  const coldCapScript = `const s=require(${JSON.stringify(path.join(root, 'services', 'store.js'))}).createStore(); if(s.getHistory('CapUser',0).length!==25)process.exit(3);`;
  childProcess.execFileSync(process.execPath, ['-e', coldCapScript], {
    env: { ...process.env, ALICIA_DATA_DIR: capData, DISCORD_GUILD_ID: '123456789012345678', MAX_HISTORY_PER_USER: '25' },
    stdio: 'ignore',
  });
  fs.rmSync(capRoot, { recursive: true, force: true });

  freshStore.setQuiet(false);
  freshStore.setCompactLinks(false);
  freshStore.setUserChannel('cacheUserRenamed', null);
  freshStore.flush();
})().catch(e => { console.error(e); process.exit(1); });
console.log('[check] Store split layout, migration, rename, and bounded flush passed.');

// 4. Verify slash commands structure
const { commands } = require('../bot/commands');
assert(Array.isArray(commands));
const names = commands.map(c => c.name);
assert.strictEqual(new Set(names).size, names.length, 'Duplicate top-level command definitions detected');
assert(names.includes('notify'));
assert(names.includes('tracker'));
assert(names.includes('track'));
assert(names.includes('cookie'));
assert(names.includes('help'));
assert(names.includes('about'));

const notifyCmd = commands.find(c => c.name === 'notify').toJSON();
const notifySubs = notifyCmd.options.map(o => o.name);
assert(!notifySubs.includes('user-channel'), 'notify user-channel must be removed');
assert(notifySubs.includes('user-channel-clear'), 'notify user-channel-clear must stay');
assert(notifySubs.includes('channel'));
assert(notifySubs.includes('clear'));
assert(notifySubs.includes('test'));
assert(notifySubs.includes('status'));

const pingCmd = commands.find(c => c.name === 'ping').toJSON();
const pingSubs = pingCmd.options.map(o => o.name);
assert(pingSubs.includes('latency'));
assert(pingSubs.includes('tiktok-channel-clear'));

const settingsCmd = commands.find(c => c.name === 'settings').toJSON();
const settingsSubs = settingsCmd.options.map(o => o.name);
assert(settingsSubs.includes('notifications'), 'settings notifications subcommand missing');
const notifSub = settingsCmd.options.find(o => o.name === 'notifications');
const notifOpts = notifSub.options.map(o => o.name);
assert(notifOpts.includes('type'), 'settings notifications missing type');
assert(notifOpts.includes('enabled'), 'settings notifications missing enabled');
assert.strictEqual(notifSub.options.find(o => o.name === 'type').required, false, 'type should be optional');
assert.strictEqual(notifSub.options.find(o => o.name === 'enabled').required, false, 'enabled should be optional');
const notifTypes = notifSub.options.find(o => o.name === 'type').choices.map(c => c.value);
for (const t of ['online', 'offline', 'gameJoin', 'gameChange', 'gameLeave']) {
  assert(notifTypes.includes(t), `settings notifications type missing ${t}`);
}

const toggleSub = settingsCmd.options.find(o => o.name === 'toggle');
assert(toggleSub, 'settings toggle subcommand missing');
const toggleOpts = toggleSub.options.map(o => o.name);
assert(toggleOpts.includes('name'), 'settings toggle missing name option');
assert(toggleOpts.includes('enabled'), 'settings toggle missing enabled option');
const toggleNames = toggleSub.options.find(o => o.name === 'name').choices.map(c => c.value);
for (const t of ['allyping', 'gameonly', 'serverinfo', 'tiktok', 'quiet', 'compactlinks']) {
  assert(toggleNames.includes(t), `settings toggle name missing ${t}`);
}

const trackerCmd = commands.find(c => c.name === 'tracker').toJSON();
const trackerSubs = trackerCmd.options.map(o => o.name);
assert(trackerSubs.includes('inspect'));
assert(trackerSubs.includes('refresh'));
const trackCmd = commands.find(c => c.name === 'track').toJSON();
const alertReset = trackCmd.options.find(o => o.name === 'alerts-reset');
assert(alertReset, 'track alerts-reset subcommand missing');
assert.strictEqual(alertReset.options.find(o => o.name === 'username').autocomplete, true);
assert.strictEqual(alertReset.options.find(o => o.name === 'type').required, false);
const boardCmd = commands.find(c => c.name === 'board').toJSON();
const boardViews = boardCmd.options.find(o => o.name === 'view').choices.map(choice => choice.value);
assert.deepStrictEqual(boardViews, ['all', 'ingame', 'online', 'offline', 'paused', 'issues']);
const serialized = JSON.stringify(commands.map(c => c.toJSON()));
assert(serialized.includes('"autocomplete":true'), 'Autocomplete options were not registered');
console.log('[check] Slash commands structure passed.');

// 5. Check for emoji in files
const emojiRegex = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
const allFiles = [...files, 'server.js', 'README.md', 'package.json', '.env.example', 'public/app.js', 'public/index.html'];
for (const file of allFiles) {
  const filePath = path.join(root, file);
  if (!fs.existsSync(filePath)) continue;
  const content = fs.readFileSync(filePath, 'utf8');
  const match = emojiRegex.exec(content);
  if (match) {
    throw new Error(`Emoji found in ${file}: ${match[0]}`);
  }
}
console.log('[check] Emoji check passed (0 emoji found).');

// 6. Test the API health/state layer
(async () => {
  const roblox = require('../services/roblox');
  assert.strictEqual(roblox.isDegraded(), false, 'API should start healthy');
  for (let i = 0; i < 3; i++) {
    await roblox.retryable(() => { throw new Error(`boom ${i}`); }, 'health-test').catch(() => {});
  }
  assert.strictEqual(roblox.isDegraded(), true, 'API should be degraded after threshold failures');
  assert.strictEqual(roblox.getHealth().consecutiveFailures, 3);
  await roblox.retryable(() => 'ok', 'health-test');
  assert.strictEqual(roblox.isDegraded(), false, 'API should recover after a success');
  assert.strictEqual(roblox.getHealth().consecutiveFailures, 0);
  console.log('[check] API health/state layer passed.');

  // 7. /notify test accepts an optional username
  const notifyCmd2 = commands.find(c => c.name === 'notify').toJSON();
  const notifyTestSub = notifyCmd2.options.find(o => o.name === 'test');
  assert(notifyTestSub, 'notify test subcommand missing');
  const testOpts = notifyTestSub.options.map(o => o.name);
  assert(testOpts.includes('username'), 'notify test missing username option');
  assert.strictEqual(notifyTestSub.options.find(o => o.name === 'username').required, false, 'username should be optional');
  console.log('[check] notify test username option passed.');

  // 8. Tracker state machine: gameLeave detection
  const { getEventType } = require('../services/tracker');
  const ingame = { resolved: true, status: 'In Game', inGame: true, gameName: 'Adopt Me', gameId: 'g1', placeId: 1 };
  const ingame2 = { resolved: true, status: 'In Game', inGame: true, gameName: 'Another', gameId: 'g2', placeId: 2 };
  const online = { resolved: true, status: 'Online', inGame: false, gameName: null, gameId: null, placeId: null };
  const offline = { resolved: true, status: 'Offline', inGame: false, gameName: null, gameId: null, placeId: null };
  const ingameSame = { ...ingame };
  assert.strictEqual(getEventType(ingame, online), 'gameLeave', 'In Game -> Online must be gameLeave');
  assert.strictEqual(getEventType(ingame, offline), 'gameLeave', 'In Game -> Offline must be gameLeave');
  assert.strictEqual(getEventType(ingame, ingame2), 'gameChange', 'In Game -> different game must be gameChange');
  assert.strictEqual(getEventType(ingame, ingameSame), 'status', 'In Game -> same game must be status (no change)');
  assert.strictEqual(getEventType(online, ingame), 'gameJoin', 'Online -> In Game must be gameJoin');
  assert.strictEqual(getEventType(online, offline), 'offline', 'Online -> Offline must be offline');
  assert.strictEqual(getEventType(offline, online), 'online', 'Offline -> Online must be online');
  assert.strictEqual(getEventType(null, online), 'initial', 'First snapshot must be initial');
  const Tracker = require('../services/tracker');
  testStore.addUser('TrackerUser');
  let statusWrites = 0;
  const originalSetStatus = testStore.setUserStatus;
  testStore.setUserStatus = (...args) => { statusWrites++; return originalSetStatus(...args); };
  const trackerProbe = new Tracker(null, { store: testStore });
  const trackerUser = testStore.findUser('TrackerUser');
  const trackerSnapshot = { username: 'TrackerUser', resolved: true, status: 'In Game', inGame: true, gameName: 'Tracker Game', gameId: 'g1', placeId: 1, sessionStartedAt: new Date().toISOString(), sessionDurationMs: 0, updatedAt: new Date().toISOString() };
  trackerProbe.publish(trackerUser, trackerSnapshot);
  trackerProbe.publish(trackerUser, trackerSnapshot);
  assert.strictEqual(statusWrites, 1, 'unchanged status must not rewrite status.json');
  assert(trackerSnapshot.sessionStartedAt, 'active session start must be tracked without history scans');
  testStore.setUserStatus = originalSetStatus;
  console.log('[check] Tracker state machine passed.');

  // 9. TikTok service (experimental) — structure only, no network
  const tiktok = require('../services/tiktok');
  assert.strictEqual(typeof tiktok.getLiveStatus, 'function', 'tiktok.getLiveStatus missing');
  assert.strictEqual(typeof tiktok.checkAlive, 'function', 'tiktok.checkAlive missing');
  assert.strictEqual(typeof tiktok.checkMany, 'function', 'tiktok.checkMany missing');
  console.log('[check] TikTok service structure passed.');

  // 9b. TikTok standalone watchlist store ops (self-cleaning)
  const watchProbe = () => {
    const st = createStore();
    const added = st.addTiktokWatch('just_soph');
    assert.strictEqual(added, 'just_soph');
    assert(st.getTiktokWatch().includes('just_soph'));
    st.addTiktokWatch('@ALLYCUTIE');
    assert(st.getTiktokWatch().includes('allycutie'), 'handle should normalize @ and case');
    st.removeTiktokWatch('just_soph');
    assert(!st.getTiktokWatch().includes('just_soph'));
    st.removeTiktokWatch('allycutie');
    assert(st.getTiktokWatch().length === 0);
  };
  watchProbe();
  console.log('[check] TikTok standalone watchlist passed.');

  // 9c. QOL: quiet mode store + board renderer
  const { buildBoardLines, buildBoardView, chunkDiscordLines, truncateDiscordText } = require('../services/discord');
  const quietStore = createStore();
  quietStore.setQuiet(true);
  assert.strictEqual(quietStore.getQuiet(), true, 'quiet on should persist');
  quietStore.setQuiet(false);
  assert.strictEqual(quietStore.getQuiet(), false, 'quiet off should persist');
  quietStore.setQuiet(true, 0.00001); // ~1ms timer
  await new Promise(r => setTimeout(r, 25));
  assert.strictEqual(quietStore.getQuiet(), false, 'timed quiet should auto-expire and self-clear');
  quietStore.setCompactLinks(true);
  assert.strictEqual(quietStore.getCompactLinks(), true, 'compact links on should persist');
  quietStore.setCompactLinks(false);
  assert.strictEqual(quietStore.getCompactLinks(), false, 'compact links off should persist');

  const boardUsers = [
    { username: 'Ally', enabled: true },
    { username: 'Bob', enabled: true },
    { username: 'Cara', enabled: true },
    { username: 'Dan', enabled: false },
    { username: 'Eve', enabled: true },
  ];
  const boardSnap = new Map([
    ['ally', { username: 'Ally', resolved: true, inGame: true, gameName: 'Adopt Me', serverType: 'public', joinUrl: 'https://join.test' }],
    ['bob', { username: 'Bob', resolved: true, inGame: false, status: 'Online' }],
    ['cara', { username: 'Cara', resolved: true, inGame: false, status: 'Offline' }],
    ['dan', { username: 'Dan', resolved: true, inGame: false, status: 'Offline' }],
    ['eve', { username: 'Eve', resolved: false, error: 'Username not found' }],
  ]);
  const board = buildBoardLines(boardUsers, boardSnap);
  assert.strictEqual(board.rows.length, 5, 'one row per tracked user');
  assert(board.rows[0].includes('Ally') && board.rows[0].includes('Adopt Me'), 'in-game user listed with game name');
  assert(board.rows[0].includes('](https://join.test)'), 'in-game row carries join link');
  assert(board.rows.some(row => row.includes('Dan') && row.includes('paused')), 'paused user must not show stale status');
  assert.strictEqual(buildBoardView(boardUsers, boardSnap, 'ingame').shown, 1);
  assert.strictEqual(buildBoardView(boardUsers, boardSnap, 'online').shown, 1);
  assert.strictEqual(buildBoardView(boardUsers, boardSnap, 'offline').shown, 1);
  assert.strictEqual(buildBoardView(boardUsers, boardSnap, 'paused').shown, 1);
  assert.strictEqual(buildBoardView(boardUsers, boardSnap, 'issues').shown, 1);
  const longRows = Array.from({ length: 50 }, (_, index) => `${index}-${'x'.repeat(220)}`);
  const chunks = chunkDiscordLines(longRows);
  assert(chunks.every(chunk => chunk.length <= 3800));
  assert.strictEqual(chunks.join('').replace(/\n/g, '').length, longRows.join('').replace(/\n/g, '').length);
  assert(truncateDiscordText('x'.repeat(3000)).length <= 2000);
  quietStore.setQuiet(false);
  quietStore.setCompactLinks(false);
  console.log('[check] QOL: quiet mode + board renderer passed.');
  console.log('[check] QOL: sanitizeChoices + together/topgames helpers.');
  const { sanitizeChoices, groupInGame, topGames } = require('../services/discord');
  const sanitized = sanitizeChoices([
    { name: ' Alice ', value: 'alice' },
    { name: 'bad\nname', value: 'bob' },
    { name: '', value: 'empty-name' },
    { name: 'empty-value', value: ' ' },
    { name: 'x'.repeat(120), value: 'toolong' },
  ]);
  assert.strictEqual(sanitized.length, 3, 'drops empty names/values, trims and caps length');
  assert.strictEqual(sanitized[0].name, 'Alice', 'name trimmed');
  assert.strictEqual(sanitized[1].name, 'bad name', 'name newlines replaced');
  assert.strictEqual(sanitized[1].value, 'bob', 'value kept');
  assert.strictEqual(sanitized[2].name, 'x'.repeat(100), 'oversized name capped at 100 chars');
  const many = sanitizeChoices(Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, value: `v${i}` })));
  assert.strictEqual(many.length, 25, 'autocomplete choices capped at 25');

  const groupSnap = [
    { username: 'Ally', displayName: 'Ally', inGame: true, gameName: 'Adopt Me', placeId: 100, gameId: 'abc', serverRegion: 'US' },
    { username: 'Bob', displayName: 'Bob', inGame: true, gameName: 'Adopt Me', placeId: 100, gameId: 'abc', serverRegion: 'US' },
    { username: 'Zwei', displayName: 'Zwei', inGame: true, gameName: 'Brookhaven', placeId: 200, gameId: 'def' },
    { username: 'Idle', displayName: 'Idle', inGame: false },
  ];
  const groups = groupInGame(groupSnap);
  assert.strictEqual(groups.length, 2, 'in-game users grouped by server instance');
  const adopt = groups.find(g => g.gameName === 'Adopt Me');
  assert(adopt && adopt.players.includes('Ally') && adopt.players.includes('Bob'), 'same server instance groups together');
  const brook = groups.find(g => g.gameName === 'Brookhaven');
  assert(brook && brook.players.length === 1, 'different instance separate group');

  const history = [
    { eventType: 'gameLeave', at: new Date(100000).toISOString(), gameName: 'Adopt Me' },
    { eventType: 'gameJoin', at: new Date(80000).toISOString(), gameName: 'Adopt Me' },
    { eventType: 'gameLeave', at: new Date(50000).toISOString(), gameName: 'Brookhaven' },
    { eventType: 'gameJoin', at: new Date(0).toISOString(), gameName: 'Brookhaven' },
  ];
  const games = topGames(history, 5);
  assert.strictEqual(games[0].game, 'Brookhaven', 'longest session ranked first');
  assert.strictEqual(games[0].ms, 50000, 'session duration computed from chronology');

  //9e. Server-type regression: only RoValra-confirmed 'public' shown,
  //never the old guessed 'private'/'joins-off' fallback (v2.5.4).
  const { buildEmbed } = require('../services/discord');
  const embedDesc = (status) => (buildEmbed({
    status: 'game', eventType: 'gameJoin', username: 'test', displayName: 'Test',
    inGame: true, gameName: 'Jailbreak', serverUptimeMs: 5000, serverRegion: 'us-east',
    ...status,
  }, { serverInfo: true }).description) || '';
  assert(!/Server: Private/.test(embedDesc({ serverType: null })), 'no Server line when RoValra unknown (null)');
  assert(!/Server: Private/.test(embedDesc({ serverType: 'private' })), 'no guessed Private label');
  assert(/Server: Public/.test(embedDesc({ serverType: 'public' })), 'RoValra-confirmed public shown');

  // new commands defined
  const allCommands = require('../bot/commands').commands;
  const cmdNames = allCommands.map(c => c.name);
  assert(cmdNames.includes('together'), 'together command missing');
  assert(cmdNames.includes('topgames'), 'topgames command missing');
  const topgamesCmd = allCommands.find(c => c.name === 'topgames');
  assert(topgamesCmd.toJSON().options.some(o => o.autocomplete), 'topgames username option should autocomplete');

  // 9. Logger: file write, redaction, tail
  const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-log-'));
  process.env.LOG_DIR = tmpLogDir;
  const logger = require('../services/logger');
  logger.init();
  const origError = console.error;
  console.error('[logger] test one');
  console.warn('[logger] test two with .ROBLOSECURITY=SECRETVALUE123');
  setTimeout(() => {
    const text = fs.readFileSync(logger.currentFile(), 'utf8');
    assert(text.includes('test one'), 'logger should capture console.error');
    assert(text.includes('test two'), 'logger should capture console.warn');
    assert(!text.includes('SECRETVALUE123'), 'logger should redact .ROBLOSECURITY');
    assert(text.includes('[REDACTED]'), 'redaction marker present');
    const tailText = logger.tail(10);
    assert(tailText.includes('test one'), 'logger.tail should return recent lines');
    console.error = origError;
    fs.rmSync(tmpLogDir, { recursive: true, force: true });
    fs.rmSync(testDataDir, { recursive: true, force: true });
    console.log('[check] Logger (write + redact + tail) passed.');
    console.log('[check] ALL TESTS PASSED.');
  }, 800);
})().catch(e => { console.error(e); process.exit(1); });
