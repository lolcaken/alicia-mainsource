// services/validators.js
// Shared validation for usernames, channels, and per-user channel targets.
// Kept dependency-free so it can be loaded by both bot and store without
// pulling in discord.js at import time.

const USERNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _\-.]{0,19}$/u;

function validateUsername(input) {
  const raw = String(input == null ? '' : input);
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('A Roblox username is required.');
  if (trimmed.length > 20) throw new Error('Roblox usernames are at most 20 characters.');
  if (!USERNAME_RE.test(trimmed)) throw new Error('That username contains characters Roblox does not allow.');
  return trimmed;
}

function validateChannel(input, { kind = 'channel' } = {}) {
  if (input == null) throw new Error(`A ${kind} is required.`);
  const id = String(input);
  if (!/^\d{17,20}$/.test(id)) throw new Error(`That ${kind} id does not look like a Discord channel.`);
  return id;
}

function sameChannel(a, b) {
  if (!a || !b) return false;
  return String(a) === String(b);
}

module.exports = { validateUsername, validateChannel, sameChannel, USERNAME_RE };
