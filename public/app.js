// public/app.js — Alicia Tracker dashboard client.
// No emoji anywhere: every icon comes from the sprite defined in
// index.html and is referenced here via icon('name').

const socket = io();
const $ = (id) => document.getElementById(id);

let state = { users: [], accounts: [], env: {}, tracker: {}, stats: {} };
let activityState = [];
let detailRefreshTimer = null;
let searchDebounceTimer = null;

const cardsEl = $('cards');
const tpl = $('cardTemplate');
const modal = $('modal');

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function icon(name, extraClass = '') {
  return `<svg class="icon ${extraClass}"><use href="#i-${name}"></use></svg>`;
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mm}m`;
  return `${mm}m`;
}

async function api(url, opt = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opt });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---------------------------------------------------------------------
// Socket.IO live updates
// ---------------------------------------------------------------------

socket.on('connect', () => {
  $('connStatus').textContent = 'live';
  $('connStatus').classList.add('live');
});
socket.on('disconnect', () => {
  $('connStatus').textContent = 'disconnected';
  $('connStatus').classList.remove('live');
});
socket.on('dashboard', (d) => applyDashboard(d));
socket.on('status', (s) => updateStatus(s));
socket.on('status-change', (s) => {
  updateStatus(s);
  addLiveActivity(s);
});

function applyDashboard(d) {
  state = d;
  renderStats();
  renderCards();
  renderAccounts();
  renderSettings();
  renderRuntime();
}

function updateStatus(s) {
  const u = state.users.find((x) => x.username.toLowerCase() === s.username.toLowerCase());
  if (!u) return;
  u.status = s;
  updateCard(u);
  renderStats();
  renderRuntime();

  const onDetail = $('view-detail')?.classList.contains('active-view');
  const detailMatches = $('detailTitle').textContent.toLowerCase().includes(s.username.toLowerCase());
  if (onDetail && detailMatches) {
    // Debounced re-render — several status events can land in the same
    // tick, so this coalesces them into a single detail-page refresh.
    clearTimeout(detailRefreshTimer);
    detailRefreshTimer = setTimeout(() => renderDetail(s.username), 450);
  }
}

function statusClass(s) {
  if (!s?.resolved) return '';
  if (s.inGame) return 'ingame';
  if (s.status === 'Online') return 'online';
  return '';
}

// ---------------------------------------------------------------------
// Overview: stats + runtime health
// ---------------------------------------------------------------------

function renderStats() {
  const statuses = state.users.map((u) => u.status).filter(Boolean);
  $('statTracked').textContent = state.users.length;
  $('statEnabled').textContent = state.users.filter((u) => u.enabled !== false).length;
  $('statOnline').textContent = statuses.filter((s) => s.resolved && s.status !== 'Offline').length;
  $('statGame').textContent = statuses.filter((s) => s.resolved && s.inGame).length;
}

function renderRuntime() {
  const t = state.tracker || {};
  const intervalS = Math.round((t.intervalMs || 5000) / 1000);

  $('lastPoll').textContent = t.lastPollAt ? `Last poll ${new Date(t.lastPollAt).toLocaleTimeString()}` : 'Never checked';
  $('runtimeState').textContent = t.lastError ? 'Error' : t.polling ? 'Polling…' : 'Ready';
  $('runtimeInterval').textContent = `${intervalS}s`;
  $('runtimeLast').textContent = t.lastPollAt ? new Date(t.lastPollAt).toLocaleString() : 'Never';
  $('runtimeWebhook').textContent = state.env.hasDiscordWebhook ? 'Configured' : 'Not configured';

  $('healthInterval').textContent = `${intervalS}s`;
  $('healthLast').textContent = t.lastPollAt ? new Date(t.lastPollAt).toLocaleTimeString() : 'Never';
  $('healthBackoff').textContent = t.backoffMs ? `${Math.round(t.backoffMs / 1000)}s` : 'None';
  $('health429').textContent = t.consecutiveRateLimits || 0;

  const degraded = Boolean(t.lastError);
  $('healthBadge').textContent = degraded ? 'Degraded' : 'Healthy';
  $('healthBadge').classList.toggle('live', !degraded);
}

// ---------------------------------------------------------------------
// Tracked-user cards
// ---------------------------------------------------------------------

function renderCards() {
  const q = $('searchInput').value.trim().toLowerCase();
  const users = state.users.filter((u) => u.username.toLowerCase().includes(q));

  cardsEl.innerHTML = '';
  if (!users.length) {
    cardsEl.innerHTML = '<div class="empty-state">No tracked users match your search.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const u of users) frag.appendChild(makeCard(u));
  cardsEl.appendChild(frag);
}

function fillCard(root, u) {
  const s = u.status || { username: u.username, resolved: false, status: 'Waiting', error: 'Waiting for first check…' };

  const avatar = root.querySelector('.avatar');
  const nextAvatarSrc = s.avatarUrl || '';
  if (avatar.src !== nextAvatarSrc) avatar.src = nextAvatarSrc;

  root.querySelector('.name').textContent = u.username;
  root.querySelector('.display-name').textContent = s.displayName || '';
  root.querySelector('.dot').className = `dot ${statusClass(s)}`;
  root.querySelector('.status-label').textContent = u.enabled === false ? 'Tracking paused' : s.error || s.status || 'Waiting';
  root.querySelector('.status-badge').textContent = s.inGame ? 'GAME' : u.enabled === false ? 'OFF' : 'LIVE';

  const g = root.querySelector('.game-name');
  g.replaceChildren();
  if (s.inGame && s.gameName) {
    const a = document.createElement('a');
    a.href = s.joinUrl || s.gameUrl || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = s.joinUrl ? `Playing ${s.gameName} · Join` : `Playing ${s.gameName}`;
    g.appendChild(a);
  } else if (s.inGame && s.joinsVisible === false) {
    g.textContent = 'In a game · joins hidden';
  } else if (s.inGame) {
    g.textContent = 'In a game · loading details';
  } else if (s.error) {
    g.textContent = s.error;
  }

  root.querySelector('.account-label').textContent = s.accountName ? `Session: ${s.accountName}` : 'No cookie session assigned';
  root.querySelector('.updated-at').textContent = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '';

  const toggle = root.querySelector('.track-toggle');
  if (toggle) toggle.checked = u.enabled !== false;
}

function makeCard(u) {
  const frag = tpl.content.cloneNode(true);
  const card = frag.querySelector('.card');
  card.dataset.username = u.username;

  const avatar = card.querySelector('.avatar');
  avatar.loading = 'lazy';
  avatar.decoding = 'async';

  fillCard(card, u);

  card.querySelector('.remove').onclick = () => removeUser(u.username);
  card.querySelector('.edit-track').onclick = () => openTrackModal(u);
  card.querySelector('.view-history').onclick = () => openHistory(u.username);
  card.querySelector('.name').onclick = () => showDetail(u.username);

  return frag;
}

function updateCard(u) {
  const card = cardsEl.querySelector(`.card[data-username="${CSS.escape(u.username)}"]`);
  if (!card) return;
  fillCard(card, u);
}

// ---------------------------------------------------------------------
// Roblox account (cookie) vault
// ---------------------------------------------------------------------

function renderAccounts() {
  const root = $('accountsList');
  root.innerHTML = '';

  if (!state.accounts.length) {
    root.innerHTML = '<div class="empty-state">No Roblox sessions yet. Add one to start authenticated presence checks.</div>';
    return;
  }

  for (const a of state.accounts) {
    const row = document.createElement('article');
    row.className = 'account-row';

    const main = document.createElement('div');
    main.className = 'account-main';

    const title = document.createElement('h3');
    title.textContent = a.name;

    const cookie = document.createElement('code');
    cookie.textContent = a.cookieMasked || 'No cookie';

    const meta = document.createElement('div');
    meta.className = 'account-meta';
    const auth = document.createElement('span');
    auth.textContent = a.lastAuth ? `Authenticated as ${a.lastAuth.name}` : a.lastError ? `Error: ${a.lastError}` : 'Not tested';
    const count = state.users.filter((u) => u.accountId === a.id).length;
    const uses = document.createElement('span');
    uses.textContent = `${count} tracked user${count === 1 ? '' : 's'}`;
    meta.append(auth, uses);

    main.append(title, cookie, meta);

    const actions = document.createElement('div');
    actions.className = 'account-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn ghost small';
    editBtn.innerHTML = `${icon('pencil')}<span>Edit</span>`;
    editBtn.onclick = () => openAccountModal(a);

    const testBtn = document.createElement('button');
    testBtn.className = 'btn ghost small';
    testBtn.innerHTML = `${icon('check')}<span>Test</span>`;
    testBtn.onclick = () => testAccount(a.id, testBtn);

    const sw = document.createElement('label');
    sw.className = 'switch';
    sw.innerHTML = `<input type="checkbox" ${a.enabled ? 'checked' : ''}><span></span>`;
    sw.querySelector('input').onchange = (e) => patchAccount(a.id, { enabled: e.target.checked });

    actions.append(editBtn, testBtn, sw);
    row.append(main, actions);
    root.appendChild(row);
  }
}

// ---------------------------------------------------------------------
// Settings / .env
// ---------------------------------------------------------------------

function renderSettings() {
  $('envPort').value = state.env.PORT || '';
  $('envPoll').value = state.env.POLL_INTERVAL_MS || '';
  $('envWebhook').value = '';
  $('envWebhook').placeholder = state.env.hasDiscordWebhook ? `Configured: ${state.env.DISCORD_WEBHOOK_URL}` : 'Paste a webhook URL';
  $('webhookState').textContent = state.env.hasDiscordWebhook ? `Current webhook: ${state.env.DISCORD_WEBHOOK_URL}` : 'No Discord webhook configured.';
}

// ---------------------------------------------------------------------
// Mutations (users / accounts)
// ---------------------------------------------------------------------

async function refresh() {
  applyDashboard(await api('/api/dashboard'));
  await loadActivity();
}

async function patchUser(username, patch) {
  try {
    await api(`/api/users/${encodeURIComponent(username)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await refresh();
  } catch (e) {
    toast(e.message);
    await refresh();
  }
}

async function removeUser(username) {
  if (!confirm(`Stop tracking @${username}?`)) return;
  await api(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
  await refresh();
}

async function patchAccount(id, patch) {
  try {
    await api(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await refresh();
  } catch (e) {
    toast(e.message);
    await refresh();
  }
}

async function testAccount(id, btn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${icon('refresh')}<span>Testing…</span>`;
  try {
    const d = await api(`/api/accounts/${id}/test`, { method: 'POST' });
    toast(`Valid cookie. Logged in as ${d.auth.name}.`);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
    await refresh();
  }
}

// ---------------------------------------------------------------------
// Modal system
// ---------------------------------------------------------------------

function openModal(title, sub, html, onSubmit) {
  $('modalTitle').textContent = title;
  $('modalSubtitle').textContent = sub;
  $('modalBody').innerHTML = html;
  modal.hidden = false;
  $('modalBody')
    .querySelector('form')
    ?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await onSubmit(new FormData(e.currentTarget));
      } catch (err) {
        toast(err.message);
      }
    });
}
$('modalClose').onclick = () => (modal.hidden = true);
modal.onclick = (e) => {
  if (e.target === modal) modal.hidden = true;
};

function accountOptions(selected) {
  const opts = state.accounts.map(
    (a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${escapeHtml(a.name)}${a.enabled ? '' : ' (disabled)'}</option>`
  );
  return `<option value="">No cookie account</option>${opts.join('')}`;
}

function openAddChooser() {
  openModal(
    'Add to Alicia Tracker',
    'Choose what you want to add.',
    `<div class="form-stack">
      <button id="chooseTrack" class="btn primary" type="button">${icon('plus')}<span>Track a Roblox username</span></button>
      <button id="chooseCookie" class="btn ghost" type="button">${icon('plus')}<span>Add a Roblox cookie</span></button>
    </div>`,
    async () => {}
  );
  $('chooseTrack').onclick = () => openTrackModal();
  $('chooseCookie').onclick = () => openAccountModal();
}

function openTrackModal(user = null) {
  const edit = Boolean(user);
  openModal(
    edit ? `Edit @${user.username}` : 'Add tracked Roblox account',
    edit ? 'Choose its cookie session, tracking and notifications.' : 'Add a username and choose which Roblox session should watch it.',
    `<form class="form-stack">
      <label>Roblox username<input name="username" value="${escapeHtml(user?.username || '')}" ${edit ? 'readonly' : ''} required placeholder="username" /></label>
      <label>Cookie session<select name="accountId">${accountOptions(user?.accountId)}</select></label>
      <div class="notice">${icon('bell')}<span>Notifications can be customized from the account detail page.</span></div>
      <div class="form-actions">
        <button type="button" class="btn ghost cancel">Cancel</button>
        <button class="btn primary">${edit ? 'Save changes' : 'Start tracking'}</button>
      </div>
    </form>`,
    async (fd) => {
      const username = fd.get('username').trim();
      const accountId = fd.get('accountId') || null;
      if (edit) await patchUser(username, { accountId });
      else await api('/api/users', { method: 'POST', body: JSON.stringify({ username, accountId }) });
      modal.hidden = true;
      await refresh();
    }
  );
  $('modalBody').querySelector('.cancel').onclick = () => (modal.hidden = true);
}

function openAccountModal(a = null) {
  const edit = Boolean(a);
  openModal(
    edit ? `Edit ${a.name}` : 'Add Roblox cookie',
    edit ? 'Rename the session or replace its cookie.' : 'Use a .ROBLOSECURITY value from a Roblox account you control.',
    `<form class="form-stack">
      <label>Account name<input name="name" value="${escapeHtml(a?.name || '')}" required placeholder="Main Roblox account" /></label>
      <label>.ROBLOSECURITY cookie<input name="cookie" type="password" placeholder="${edit ? 'Leave blank to keep the current cookie' : 'Paste cookie here'}" ${edit ? '' : 'required'} autocomplete="off" /></label>
      <div class="form-actions">
        ${edit ? '<button type="button" class="btn ghost delete-account">Delete</button>' : ''}
        <button type="button" class="btn ghost cancel">Cancel</button>
        <button class="btn primary">${edit ? 'Save account' : 'Add cookie'}</button>
      </div>
    </form>`,
    async (fd) => {
      const payload = { name: fd.get('name').trim() };
      const cookie = fd.get('cookie').trim();
      if (cookie) payload.cookie = cookie;
      if (edit) await patchAccount(a.id, payload);
      else await api('/api/accounts', { method: 'POST', body: JSON.stringify(payload) });
      modal.hidden = true;
      await refresh();
    }
  );
  const del = $('modalBody').querySelector('.delete-account');
  if (del) {
    del.onclick = async () => {
      if (!confirm(`Delete ${a.name}?`)) return;
      await api(`/api/accounts/${a.id}`, { method: 'DELETE' });
      modal.hidden = true;
      await refresh();
    };
  }
  $('modalBody').querySelector('.cancel').onclick = () => (modal.hidden = true);
}

// ---------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------

async function loadActivity() {
  try {
    const events = await api('/api/activity?limit=40');
    activityState = events;
    renderActivity(activityState);
  } catch (e) {
    $('activityFeed').innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
  }
}

function eventMeta(e) {
  if (e.eventType === 'gameJoin') return { name: 'gamepad', type: 'ingame' };
  if (e.eventType === 'gameChange') return { name: 'swap', type: 'ingame' };
  if (e.eventType === 'offline') return { name: 'power', type: 'offline' };
  if (e.eventType === 'online') return { name: 'signal', type: 'online' };
  return { name: 'dot', type: '' };
}

function eventText(e) {
  if (e.eventType === 'gameJoin') return `joined ${e.gameName || 'a game'}`;
  if (e.eventType === 'gameChange') return `changed game to ${e.gameName || 'another game'}`;
  if (e.eventType === 'offline') return 'went offline';
  if (e.eventType === 'online') return 'came online';
  return e.gameName ? `${e.status} · ${e.gameName}` : e.status;
}

function renderActivity(events) {
  const el = $('activityFeed');
  el.replaceChildren();

  if (!events.length) {
    el.innerHTML = '<div class="empty-state">No activity yet.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const e of events) {
    const meta = eventMeta(e);
    const row = document.createElement('button');
    row.className = 'activity-item';
    row.innerHTML = `
      <span class="activity-icon type-${meta.type}">${icon(meta.name)}</span>
      <span class="activity-copy">
        <b>${escapeHtml(e.username)}</b> ${escapeHtml(eventText(e))}
        <small>${new Date(e.at).toLocaleString()}${e.accountName ? ` · ${escapeHtml(e.accountName)}` : ''}</small>
      </span>`;
    row.onclick = () => showDetail(e.username);
    frag.appendChild(row);
  }
  el.appendChild(frag);
}

function addLiveActivity(s) {
  const ev = {
    ...s,
    at: s.updatedAt || new Date().toISOString(),
    status: s.status,
    eventType: s.eventType,
    username: s.username,
    gameName: s.gameName,
    accountName: s.accountName,
  };
  activityState = [ev, ...activityState.filter((e) => !(e.username === ev.username && e.at === ev.at))].slice(0, 40);
  renderActivity(activityState);
}

// ---------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------

async function showDetail(username) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active-view'));
  $('view-detail').classList.add('active-view');
  await renderDetail(username);
}

function notifyCheck(key, label, checked) {
  return `<label class="notify-box"><input class="notify-input" data-key="${key}" type="checkbox" ${checked ? 'checked' : ''}><span><b>${label}</b><small>Discord event</small></span></label>`;
}

async function renderDetail(username) {
  $('detailTitle').textContent = `@${username}`;
  $('detailSubtitle').textContent = 'Loading account details…';

  const u = state.users.find((x) => x.username.toLowerCase() === username.toLowerCase());
  const s = u?.status;

  try {
    const [stats, history] = await Promise.all([
      api(`/api/stats/${encodeURIComponent(username)}`),
      api(`/api/history/${encodeURIComponent(username)}?limit=20`),
    ]);

    $('detailSubtitle').textContent = s?.displayName ? `${s.displayName} · ${s.status || 'Unknown'}` : 'Tracked Roblox account';

    const dur = fmtDuration(stats.totalOnlineMs);
    const game = stats.topGame || '—';

    const current = s?.inGame
      ? `<div class="current-game">
          <div><span class="eyebrow">Current game</span><h3>${escapeHtml(s.gameName || 'Unknown game')}</h3><p>Server ${escapeHtml(s.gameId || 'Unavailable')}</p></div>
          ${s.joinUrl ? `<a class="btn primary join-btn" target="_blank" rel="noopener" href="${escapeHtml(s.joinUrl)}">${icon('gamepad')}<span>Join Server</span></a>` : ''}
        </div>`
      : '<div class="current-game muted-box">Not currently in a game.</div>';

    $('detailBody').innerHTML = `
      <div class="detail-grid">
        <div class="glass profile-panel">
          <div class="profile-main">
            <img class="detail-avatar" src="${s?.avatarUrl || ''}" alt="" />
            <div>
              <h3>${escapeHtml(s?.displayName || username)}</h3>
              <p>@${escapeHtml(username)}</p>
              <span class="status-chip ${statusClass(s)}">${escapeHtml(s?.status || 'Waiting')}</span>
            </div>
          </div>
          <div class="detail-actions">
            <button id="detailEdit" class="btn ghost small">${icon('pencil')}<span>Edit tracker</span></button>
            <button id="detailHistory" class="btn ghost small">${icon('clock')}<span>Full history</span></button>
            <label class="switch"><input id="detailToggle" type="checkbox" ${u?.enabled !== false ? 'checked' : ''}><span></span></label>
          </div>
        </div>

        <div class="stat-grid">
          <div class="glass stat"><span>Online time</span><strong>${dur}</strong><small>from recorded history</small></div>
          <div class="glass stat"><span>Sessions</span><strong>${stats.sessions}</strong><small>recorded sessions</small></div>
          <div class="glass stat"><span>Top game</span><strong class="stat-text">${escapeHtml(game)}</strong><small>${stats.eventCount} events</small></div>
        </div>

        ${current}

        <div class="glass panel">
          <div class="section-head">
            <div><h3>${icon('bell', 'small')}Notification rules</h3><p>Choose which events can send to Discord.</p></div>
          </div>
          <div class="notify-grid">
            ${notifyCheck('online', 'Online', u?.notifications?.online !== false)}
            ${notifyCheck('offline', 'Offline', u?.notifications?.offline !== false)}
            ${notifyCheck('gameJoin', 'Game joined', u?.notifications?.gameJoin !== false)}
            ${notifyCheck('gameChange', 'Game changed', u?.notifications?.gameChange !== false)}
          </div>
        </div>

        <div class="glass panel">
          <div class="section-head"><div><h3>Recent history</h3></div></div>
          <div class="mini-history">
            ${
              history.length
                ? history
                    .map((e) => `<div>${icon(eventMeta(e).name)}<b>${escapeHtml(eventText(e))}</b><small>${new Date(e.at).toLocaleString()}</small></div>`)
                    .join('')
                : '<div class="empty-state">No history yet.</div>'
            }
          </div>
        </div>
      </div>`;

    $('detailEdit').onclick = () => openTrackModal(u);
    $('detailHistory').onclick = () => openHistory(username);
    $('detailToggle').onchange = (e) => patchUser(username, { enabled: e.target.checked });
    document.querySelectorAll('.notify-input').forEach((input) => {
      input.onchange = async (e) => {
        const notifications = { ...u.notifications, [e.target.dataset.key]: e.target.checked };
        await patchUser(username, { notifications });
      };
    });
  } catch (e) {
    $('detailBody').innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
    $('detailSubtitle').textContent = 'Unable to load details';
  }
}

async function openHistory(username) {
  await showDetail(username);
}

// ---------------------------------------------------------------------
// Static event wiring
// ---------------------------------------------------------------------

$('backDetail').onclick = () => {
  document.querySelector('[data-view="overview"]').click();
};

// Debounced search — avoids a full card-list rebuild on every keystroke.
$('searchInput').oninput = () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(renderCards, 120);
};

$('refreshBtn').onclick = refresh;
$('activityRefresh').onclick = loadActivity;
$('addBtn').onclick = openAddChooser;
$('addAccountBtn').onclick = () => openAccountModal();

$('pollBtn').onclick = async () => {
  const btn = $('pollBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${icon('refresh')}<span>Checking…</span>`;
  try {
    await api('/api/poll', { method: 'POST' });
    await refresh();
    toast('Poll complete');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
};

$('testWebhookBtn').onclick = async () => {
  const btn = $('testWebhookBtn');
  const result = $('testWebhookResult');
  btn.disabled = true;
  result.textContent = 'Sending…';
  try {
    await api('/api/test-webhook', { method: 'POST' });
    result.innerHTML = `${icon('check')} Sent`;
  } catch (e) {
    result.textContent = e.message;
  } finally {
    btn.disabled = false;
    setTimeout(() => (result.innerHTML = ''), 5000);
  }
};

$('settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  const payload = { PORT: fd.get('PORT'), POLL_INTERVAL_MS: fd.get('POLL_INTERVAL_MS') };
  if (fd.get('DISCORD_WEBHOOK_URL').trim()) payload.DISCORD_WEBHOOK_URL = fd.get('DISCORD_WEBHOOK_URL').trim();

  const result = $('settingsResult');
  try {
    const d = await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
    result.innerHTML = d.restartRequired ? 'Saved. Restart required for PORT.' : `${icon('check')} Saved`;
    await refresh();
  } catch (err) {
    result.textContent = err.message;
  }
  setTimeout(() => (result.innerHTML = ''), 5000);
};

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active-view'));
    tab.classList.add('active');
    $(`view-${tab.dataset.view}`).classList.add('active-view');
  };
}

refresh().catch((e) => {
  $('cards').innerHTML = `<div class="empty-state">Could not load dashboard: ${escapeHtml(e.message)}</div>`;
});
