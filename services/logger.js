// services/logger.js
// Persistent error + warning logging to errorlogsfordebug/errors.log.
// Routes console.error / console.warn into a rotating file while keeping
// panel output intact. Deliberately small, dependency-free, and never throws.
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'errorlogsfordebug');
const LOG_DIR = process.env.LOG_DIR || DEFAULT_DIR;
const MAX_MB = Math.max(1, Number(process.env.LOG_MAX_MB) || 1);
const MAX_FILES = Math.max(1, Number(process.env.LOG_MAX_FILES) || 5);
const MAX_BYTES = MAX_MB * 1024 * 1024;

const ACTIVE = 'errors.log';
let chain = Promise.resolve();
let patched = false;
let lastLine = '';

function logPath() { return path.join(LOG_DIR, ACTIVE); }

function redact(text) {
  if (!text) return text;
  // .ROBLOSECURITY cookies, Bearer tokens, and common secret assignments.
  return String(text)
    .replace(/(\.ROBLOSECURITY[=:]?\s*)([A-Za-z0-9._-]+)/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|authorization|cookie)[=:]\s*)([^\s,;"']+)/gi, '$1[REDACTED]');
}

function format(level, args) {
  const ts = new Date().toISOString();
  const joined = args.map(a => (a instanceof Error ? (a.stack || a.message) : (typeof a === 'object' ? JSON.stringify(a) : String(a))));
  const body = redact(joined.join(' '));
  const line = `${ts} | ${level} | ${body}`;
  lastLine = line;
  return line;
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(logPath());
    if (stat.size < MAX_BYTES) return;
    // Shift errors.N.log -> errors.N+1.log, oldest deleted.
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = path.join(LOG_DIR, i === 1 ? ACTIVE : `errors.${i - 1}.log`);
      const to = path.join(LOG_DIR, `errors.${i}.log`);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
  } catch { /* no log yet or unreadable; ignore */ }
}

function writeLine(line) {
  chain = chain.then(() => {
    try {
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(logPath(), line + '\n', { encoding: 'utf8' });
    } catch { /* logging must never crash the bot */ }
  });
}

function log(level, ...args) {
  if (!patched) return;
  writeLine(format(level, args));
}

function error(...args) { log('ERROR', ...args); }
function warn(...args) { log('WARN', ...args); }

function currentFile() { return logPath(); }

// Last ~200 lines of the active log for the /logs endpoint.
function tail(maxLines = 200) {
  try {
    const text = fs.readFileSync(logPath(), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-maxLines).join('\n');
  } catch {
    return 'No log file yet.';
  }
}

function init() {
  if (patched) return;
  patched = true;
  if (!fs.existsSync(LOG_DIR)) {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  }
  // Patch console.error / console.warn: keep original output, add file write.
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args) => { try { origError.apply(console, args); } catch {} writeLine(format('ERROR', args)); };
  console.warn = (...args) => { try { origWarn.apply(console, args); } catch {} writeLine(format('WARN', args)); };
  console.log('[logger] initialized:', currentFile());
}

module.exports = { init, error, warn, tail, currentFile, get lastLine() { return lastLine; } };