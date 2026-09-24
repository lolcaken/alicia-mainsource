// services/notifier.js
// Compatibility notifier retained for older integrations. The current
// single-server bot sends alerts through the configured Discord channel.

const webhook = require('./discord');

let botSender = null; // set by bot/index.js once the client is ready

/**
 * Registered by the bot once it's logged in and has a channel to post to.
 * @param {(status: object, opts: object) => Promise<void>} fn
 */
function registerBotSender(fn) {
  botSender = fn;
}

function clearBotSender() {
  botSender = null;
}

async function notify(status, opts = {}) {
  if (botSender) {
    try {
      await botSender(status, opts);
      return;
    } catch (err) {
      if (opts.test) throw err;
      console.error('[notifier] bot send failed, falling back to webhook:', err.message);
    }
  }
  return webhook.notify(status, opts);
}

module.exports = { notify, registerBotSender, clearBotSender };
