// services/settings.js
// Legacy helper for reading and patching the supported subset of .env values.
//
// IMPORTANT: setEnv() preserves every key already in .env — including ones
// it doesn't know about (DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, etc.) — and
// only overwrites the ones being patched. An earlier version rewrote the
// whole file from a hardcoded template, which would silently delete any
// key not on that template (like bot credentials) the next time someone
// saved a setting. Never go back to that.

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');
const EDITABLE_KEYS = ['PORT', 'POLL_INTERVAL_MS', 'DISCORD_WEBHOOK_URL', 'DISCORD_NOTIFY_CHANNEL_ID'];

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readCurrent() {
  let text = '';
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {}
  return parseEnv(text);
}

function getEnv() {
  const parsed = readCurrent();
  return Object.fromEntries(EDITABLE_KEYS.map((key) => [key, parsed[key] ?? process.env[key] ?? '']));
}

function setEnv(patch) {
  const parsed = readCurrent();
  for (const key of EDITABLE_KEYS) {
    if (patch[key] !== undefined) parsed[key] = String(patch[key]);
  }
  // Roblox cookies never belong in .env — they live in data/accounts.json,
  // masked everywhere else. Strip it out if an old .env still has it.
  delete parsed.ROBLOX_COOKIE;

  const keys = Object.keys(parsed);
  const lines = ['# Alicia Tracker configuration', ...keys.map((k) => `${k}=${parsed[k] ?? ''}`), ''];
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
  for (const [key, value] of Object.entries(parsed)) process.env[key] = value;
  return Object.fromEntries(EDITABLE_KEYS.map((key) => [key, parsed[key] ?? '']));
}

module.exports = { getEnv, setEnv, EDITABLE_KEYS };
