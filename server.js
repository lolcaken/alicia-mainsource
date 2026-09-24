// Alicia Tracker — single-server Discord application host entrypoint.
// Lightweight HTTP health endpoint for Pterodactyl-style hosts.

try { require('dotenv').config(); } catch {}

const logger = require('./services/logger');
logger.init();

const http = require('http');
const crypto = require('crypto');
const PORT = Number(process.env.PORT) || 3000;
const HOST = String(process.env.HOST || '127.0.0.1').trim();
const bot = require('./bot');
const { createStore } = require('./services/store');
let healthReporter = () => null;
if (typeof bot.attachHealthReporter === 'function') bot.attachHealthReporter(fn => { healthReporter = fn; });

const healthServer = http.createServer((req, res) => {
  if (req.url === '/logs' || req.url.startsWith('/logs?')) {
    const expected = String(process.env.LOG_ACCESS_TOKEN || '');
    const url = new URL(req.url, 'http://localhost');
    const provided = String(req.headers['x-log-token'] || url.searchParams.get('token') || '');
    const valid = expected && provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!valid) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(logger.tail(200));
    return;
  }
  if (req.url === '/health' || req.url === '/') {
    const poller = healthReporter() || {};
    const ready = poller.ready === true;
    const ok = ready && !poller.lastError;
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok,
      ready,
      service: 'alicia-tracker',
      mode: 'single-server-discord',
      poller: {
        ok: !poller.lastError,
        polling: poller.polling || false,
        lastPollAt: poller.lastPollAt || null,
        lastError: poller.lastError || null,
        degraded: poller.degraded || false,
        tracked: poller.tracked || 0,
        intervalMs: poller.intervalMs || null,
        backoffMs: poller.backoffMs || 0,
        lastPollDurationMs: poller.lastPollDurationMs || null,
        pollCount: poller.pollCount || 0,
        failedPollCount: poller.failedPollCount || 0,
      },
      updatedAt: new Date().toISOString(),
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

healthServer.on('error', err => {
  console.error(`[alicia-tracker] health server error: ${err.message}`);
  if (err.code === 'EADDRINUSE') process.exitCode = 1;
});

healthServer.listen(PORT, HOST, () => {
  console.log(`[alicia-tracker] health server listening on port ${PORT}`);
});

process.on('unhandledRejection', err => console.error('[process] unhandled rejection:', err?.stack || err));
process.on('uncaughtException', err => {
  console.error('[process] uncaught exception:', err?.stack || err);
  process.exitCode = 1;
  try { createStore().flushOrThrow(); } catch (flushError) { console.error('[process] final storage flush failed:', flushError.message); }
  try { healthServer.close(); } catch {}
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.log(`[process] received ${signal}; shutting down.`);
    try { createStore().flushOrThrow(); } catch (error) { console.error('[process] storage flush failed:', error.message); }
    healthServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

bot.start();
