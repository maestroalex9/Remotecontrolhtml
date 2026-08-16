// ── State ──────────────────────────────────────────────────────────────────────

const STORAGE_URL  = 'rc-relay-url';
const STORAGE_ROOM = 'rc-workspace';

let socket        = null;
let reconnTimer   = null;
let intentClose   = false;
let attempt       = 0;
let connState     = 'offline';
let lastEvent     = 'Ready to connect';
let devices       = {};
let messageCount  = 0;
let filterState   = 'all';
let selectedId    = null;   // Device selected for control
let maximizedId   = null;   // Device currently maximized
let inspectedId   = null;
let toastTimer    = null;

// Per-device control state
const lockedDevices = new Set();   // lockTouch active — phone touch is blocked
const frozenDevices = new Set();   // freeze active  — local frame rendering paused

// gesture tracking for frame surfaces
const gestureMap = new Map();

// ── Init ───────────────────────────────────────────────────────────────────────

(function init() {
  // ── URL query-parameter pre-fill ──────────────────────────────────────────
  // Supported params:
  //   ?session=<room>   — pre-fill the Workspace/session field  (alias: room, workspace)
  //   ?url=<wsUrl>      — pre-fill the Relay server URL         (alias: relay, server)
  // URL params take priority over localStorage so bookmarks / shared links always win.
  // Example: remotecontrol.html?session=office_phones&url=wss://my-relay.railway.app
  try {
    const params  = new URLSearchParams(window.location.search);
    const session = params.get('session') || params.get('room') || params.get('workspace');
    const wsUrl   = params.get('url')     || params.get('relay') || params.get('server');

    const u = wsUrl   || localStorage.getItem(STORAGE_URL);
    const r = session || localStorage.getItem(STORAGE_ROOM);
    if (u) document.getElementById('url-input').value  = u;
    if (r) document.getElementById('room-input').value = r;
  } catch {}
  setInterval(() => {
    document.querySelectorAll('[data-age-ts]').forEach(el => {
      const ts = parseInt(el.getAttribute('data-age-ts'), 10);
      el.textContent = formatAge(ts);
    });
    if (maximizedId) updateMaximizeStats();
  }, 1000);
  renderGrid();
  updateMetrics();
})();

// ── Relay connection ──────────────────────────────────────────────────────────

function getInputs() {
  return {
    url:  (document.getElementById('url-input').value  || '').trim(),
    room: (document.getElementById('room-input').value || '').trim() || 'workspace_hub',
  };
}

function connect() {
  const { url, room } = getInputs();
  if (!url) return;
  intentClose = false;
  clearTimeout(reconnTimer);
  if (socket) { try { socket.close(); } catch {} }
  setConnState(attempt > 0 ? 'reconnecting' : 'connecting', `Connecting to ${url}`);
  try {
    socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      attempt = 0;
      socket.send(JSON.stringify({ type: 'register', role: 'pc', sessionId: room, session: room }));
      setConnState('connected', `Registered as ${room}`);
    };
    socket.onmessage = onMessage;
    socket.onerror   = () => setConnState('error', 'Relay connection error');
    socket.onclose   = () => {
      socket = null;
      if (intentClose) { setConnState('offline', 'Disconnected'); return; }
      attempt++;
      const delay = Math.min(30000, 800 * Math.pow(2, Math.min(attempt - 1, 5)));
      setConnState('reconnecting', `Reconnecting in ${Math.ceil(delay/1000)}s`);
      reconnTimer = setTimeout(connect, delay);
    };
  } catch {
    setConnState('error', 'Invalid relay URL');
  }
}

function disconnect() {
  intentClose = true;
  clearTimeout(reconnTimer);
  if (socket) { try { socket.close(); } catch {} socket = null; }
  setConnState('offline', 'Disconnected');
}

function sendMsg(msg) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

// ── Message handling ──────────────────────────────────────────────────────────

function onMessage(e) {
  if (e.data instanceof ArrayBuffer) { receiveFrame(e.data); return; }
  if (e.data instanceof Blob)        { e.data.arrayBuffer().then(receiveFrame).catch(() => {}); return; }
  if (typeof e.data !== 'string')    return;
  try {
    const msg  = JSON.parse(e.data);
    const type = String(msg.type || '').toLowerCase();
    if (type === 'peer_connected' || type === 'peer_reconnected') {
      const id   = msg.sessionId || msg.session;
      const role = String(msg.role || '');
      if (id && role === 'android') {
        if (!devices[id]) {
          devices[id] = { id, frame: null, lastFrameAt: null, frameTimes: [],
            status: 'connected', bytes: 0, connectedAt: Date.now() };
          renderGrid();
        } else {
          devices[id].status = 'connected';
          updateTile(id);
        }
        setLastEvent(`Device ${id} connected — ready to stream`);
        updateMetrics();
      }
    } else if (type === 'peer_stale') {
      const id = msg.sessionId || msg.session;
      if (id && devices[id]) {
        devices[id].status = 'stale';
        updateTile(id);
        setLastEvent(`Device ${id} reconnecting…`);
        updateMetrics();
      }
    } else if (type === 'peer_disconnected') {
      const id = msg.sessionId || msg.session || msg.target || msg.peer;
      if (id) {
        delete devices[id];
        if (selectedId  === id) selectDevice(null);
        if (maximizedId === id) closeMaximize();
        setLastEvent(`Device ${id} disconnected`);
        renderGrid(); updateMetrics();
      }
    } else if (type === 'ping' || type === 'heartbeat') {
      sendMsg({ type: 'pong' });
      setLastEvent('Heartbeat acknowledged');
    } else if (type === 'pong') {
      setLastEvent('Relay healthy');
    }
    messageCount++;
    updateMetrics();
  } catch {}
}

function receiveFrame(buf) {
  if (buf.byteLength < 4) return;
  const view = new DataView(buf);
  const slen = view.getUint32(0);
  if (slen < 1 || 4 + slen >= buf.byteLength) return;
  const sid  = new TextDecoder().decode(new Uint8Array(buf, 4, slen));
  // Frozen — drop the new frame so the last displayed frame stays on screen
  // if (frozenDevices.has(sid)) { messageCount++; updateMetrics(); return; }
  const jpeg = buf.slice(4 + slen);
  const url  = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
  const now  = Date.now();
  const prev = devices[sid];
  const times = [...(prev?.frameTimes || []), now].filter(t => now - t < 15000).slice(-30);
  if (prev?.frame) URL.revokeObjectURL(prev.frame);
  devices[sid] = { id: sid, frame: url, lastFrameAt: now, frameTimes: times,
    status: 'streaming', bytes: jpeg.byteLength, connectedAt: prev?.connectedAt || now };
  messageCount++;
  updateTile(sid);
  if (maximizedId === sid) updateMaximizeFrame();
  updateMetrics();
}

// ── Start / Stop Capture ──────────────────────────────────────────────────────

function startCaptureDevice(id) {
  sendMsg({ type: 'startCapture', target: id });
  showToast(`▶ Starting capture on ${id}`);
}

function stopCaptureDevice(id) {
  sendMsg({ type: 'stopCapture', target: id });
  showToast(`⏹ Capture stopped on ${id}`);
  if (devices[id]) { devices[id].status = 'connected'; updateTile(id); updateMetrics(); }
}

// ── Lock / Freeze toggles ─────────────────────────────────────────────────────

function toggleLockDevice(id) {
  const locked = !lockedDevices.has(id);
  if (locked) lockedDevices.add(id); else lockedDevices.delete(id);
  sendMsg({ type: 'lockTouch', target: id, locked });
  showToast(locked ? '🔒 Control mode on' : '🔓 Control released');
  // Refresh tile UI
  const tile = document.querySelector(`[data-tile-id="${escAttr(id)}"]`);
  if (tile) {
    const btn = tile.querySelector('.lock-btn');
    if (btn) btn.classList.toggle('active', locked);
    const lbl = tile.querySelector('.tile-status-dot');
    if (lbl && locked) lbl.style.background = '#ef4444';
    else if (lbl) lbl.style.background = '';
  }
  // Refresh maximize overlay button
  if (maximizedId === id) {
    const btn = document.getElementById('max-lock-btn');
    if (btn) btn.classList.toggle('active', locked);
  }
}

function toggleFreezeDevice(id) {
  const frozen = !frozenDevices.has(id);
  if (frozen) frozenDevices.add(id); else frozenDevices.delete(id);
  // Tell the phone to pause/resume its capture loop (saves bandwidth too)
  sendMsg({ type: 'freeze', target: id, frozen });
  showToast(frozen ? '⏸ Phone capture paused' : '▶ Phone capture resumed');
  // Refresh tile UI
  const tile = document.querySelector(`[data-tile-id="${escAttr(id)}"]`);
  if (tile) {
    const btn = tile.querySelector('.freeze-btn');
    if (btn) btn.classList.toggle('active', frozen);
    const hint = tile.querySelector('.tile-touch-hint');
    if (hint) hint.style.opacity = frozen ? '0' : '';
    const frame = tile.querySelector('.tile-frame');
    if (frame) {
      let overlay = frame.querySelector('.freeze-overlay');
      if (frozen && !overlay) {
        overlay = document.createElement('div');
        overlay.className = 'freeze-overlay';
        overlay.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Paused</span>';
        frame.appendChild(overlay);
      } else if (!frozen && overlay) overlay.remove();
    }
  }
  // Refresh maximize overlay button
  if (maximizedId === id) {
    const btn = document.getElementById('max-freeze-btn');
    if (btn) btn.classList.toggle('active', frozen);
  }
}

// ── Device selection ──────────────────────────────────────────────────────────

function selectDevice(id) {
  selectedId = id;
  // Update tile borders
  document.querySelectorAll('.tile').forEach(el => {
    el.classList.toggle('selected', el.dataset.tileId === id);
  });
  // Update control banner
  const banner = document.getElementById('control-banner');
  if (id) {
    banner.style.display = 'block';
    document.getElementById('control-banner-id').textContent = id;
  } else {
    banner.style.display = 'none';
  }
  // Update maximize select button
  if (maximizedId) {
    const btn = document.getElementById('max-select-btn');
    btn.classList.toggle('active', maximizedId === id);
  }
}

function toggleSelectMaximized() {
  if (!maximizedId) return;
  selectDevice(selectedId === maximizedId ? null : maximizedId);
}

// ── Maximize ──────────────────────────────────────────────────────────────────

function openMaximize(id) {
  maximizedId = id;
  const overlay = document.getElementById('maximize-overlay');
  overlay.classList.add('open');
  // Header info
  const d = devices[id] || {};
  document.getElementById('max-device-id').textContent = id;
  updateMaximizeStats();
  updateMaximizeFrame();
  // Select / lock / freeze btn state
  document.getElementById('max-select-btn').classList.toggle('active', selectedId === id);
  document.getElementById('max-lock-btn').classList.toggle('active', lockedDevices.has(id));
  document.getElementById('max-freeze-btn').classList.toggle('active', frozenDevices.has(id));
  // Attach pointer events
  const frame = document.getElementById('maximize-frame');
  frame.onpointerdown = (e) => {
    frame.setPointerCapture(e.pointerId);
    const r = frame.getBoundingClientRect();
    gestureMap.set('max-' + e.pointerId, {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top)  / r.height)),
      time: Date.now(), clientX: e.clientX, clientY: e.clientY,
    });
  };
  frame.onpointerup = (e) => {
    const key   = 'max-' + e.pointerId;
    const start = gestureMap.get(key);
    gestureMap.delete(key);
    if (!start || !maximizedId) return;
    // if (frozenDevices.has(maximizedId)) return;
    const r    = frame.getBoundingClientRect();
    const ex   = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const ey   = Math.min(1, Math.max(0, (e.clientY - r.top)  / r.height));
    // Cap at 300 ms so Android scroll fling fires correctly
    const dt   = Math.min(300, Math.max(80, Date.now() - start.time));
    const dist = Math.hypot(ex - start.x, ey - start.y);
    if (dist < 0.02) {
      sendMsg({ type: 'tap', target: maximizedId, x: +ex.toFixed(4), y: +ey.toFixed(4) });
      showTapRipple(e.clientX, e.clientY, frame);
      showToast('Tap sent');
    } else {
      sendMsg({ type: 'swipe', target: maximizedId, fromX: +start.x.toFixed(4), fromY: +start.y.toFixed(4), toX: +ex.toFixed(4), toY: +ey.toFixed(4), duration: dt });
      showToast('Swipe sent');
    }
  };
}

function closeMaximize() {
  maximizedId = null;
  document.getElementById('maximize-overlay').classList.remove('open');
  const frame = document.getElementById('maximize-frame');
  frame.onpointerdown = null; frame.onpointerup = null;
}

function openInspectorFromMax() {
  if (maximizedId) openInspector(maximizedId);
}

function updateMaximizeFrame() {
  if (!maximizedId) return;
  const d     = devices[maximizedId];
  const frame = document.getElementById('maximize-frame');
  // remove old ripples
  frame.querySelectorAll('.touch-ripple').forEach(r => r.remove());
  const existing = frame.querySelector('img');
  if (d?.frame) {
    if (existing) {
      existing.src = d.frame;
    } else {
      frame.innerHTML = `<img src="${escAttr(d.frame)}" alt="" />`;
    }
  } else {
    frame.innerHTML = `<div class="maximize-frame-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="13" x="3" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg><span>Awaiting stream</span></div>`;
  }
}

function updateMaximizeStats() {
  if (!maximizedId) return;
  const d = devices[maximizedId];
  if (!d) return;
  const fps = d.frameTimes.length > 1
    ? Math.min(60, Math.round((d.frameTimes.length - 1) / 15 * 10) / 10).toFixed(1) : '0.0';
  document.getElementById('max-fps').textContent    = fps;
  document.getElementById('max-age').textContent    = formatAge(d.lastFrameAt);
  document.getElementById('max-size').textContent   = d.bytes ? (d.bytes/1024).toFixed(0)+'KB' : '—';
  const dot = document.getElementById('max-status-dot');
  dot.className = `maximize-status-dot ${d.status}`;
  document.getElementById('max-status-text').textContent = statusLabel(d.status);
}

function showTapRipple(clientX, clientY, container) {
  const r = container.getBoundingClientRect();
  const ripple = document.createElement('div');
  ripple.className = 'touch-ripple';
  ripple.style.left = (clientX - r.left) + 'px';
  ripple.style.top  = (clientY - r.top)  + 'px';
  container.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
}

// ── State helpers ─────────────────────────────────────────────────────────────

function setConnState(s, ev) {
  connState = s; lastEvent = ev;
  const labels = { offline:'Offline', connecting:'Connecting…', connected:'Connected', reconnecting:'Reconnecting…', error:'Connection error' };
  document.getElementById('status-dot').className = `status-dot ${s}`;
  document.getElementById('status-text').textContent = labels[s] || s;
  document.getElementById('status-sub').textContent  = (s==='connecting'||s==='connected'||s==='reconnecting') ? ev : '';
  const btn = document.getElementById('main-btn');
  if (s === 'connected' || s === 'connecting' || s === 'reconnecting') {
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/></svg> Disconnect`;
    btn.onclick = () => { disconnect(); showToast('Disconnected'); };
  } else {
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9a2 2 0 0 1 0-4h.01M20 9a2 2 0 0 0 0-4h-.01M12 4v2m0 12v2m0-16v2M8 15l-1 1M16 15l1 1M8 9l-1-1M16 9l1-1m-5 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/></svg> Connect to relay`;
    btn.onclick = handleMainBtn;
  }
  renderBanner();
}

function setLastEvent(ev) { lastEvent = ev; document.getElementById('status-sub').textContent = ev; }

function updateMetrics() {
  const all    = Object.values(devices);
  const active = all.filter(d => d.status === 'streaming').length;
  const quiet  = all.filter(d => d.status !== 'streaming').length;
  document.getElementById('m-devices').textContent   = String(all.length).padStart(2,'0');
  document.getElementById('m-streaming').textContent = String(active).padStart(2,'0');
  document.getElementById('m-quiet').textContent     = String(quiet).padStart(2,'0');
  document.getElementById('m-events').textContent    = String(messageCount);
  document.getElementById('hero-sub').textContent    = `Live fleet dashboard — ${all.length} device${all.length!==1?'s':''} in workspace`;
  document.getElementById('m-quiet').className = 'metric-value ' + (quiet > 0 ? 'col-amber' : 'col-slate');
}

// ── Render ────────────────────────────────────────────────────────────────────

function getVisible() {
  const q = (document.getElementById('search-input').value || '').toLowerCase();
  return Object.values(devices)
    .filter(d => d.id.toLowerCase().includes(q) && (filterState==='all' || d.status===filterState))
    .sort((a,b) => a.id.localeCompare(b.id));
}

function statusLabel(s) {
  if (s==='streaming')  return 'Streaming';
  if (s==='connected')  return 'Connected';
  if (s==='stale')      return 'Stale';
  return 'Screen off';
}
function formatAge(ts) {
  if (!ts) return 'No frame';
  const s = Math.max(0, Math.floor((Date.now()-ts)/1000));
  if (s<2) return 'Just now'; if (s<60) return `${s}s ago`; return `${Math.floor(s/60)}m ago`;
}

function renderBanner() {
  const banner = document.getElementById('banner');
  const isLive = connState==='connected', isBusy = connState==='connecting'||connState==='reconnecting';
  if (isLive) { banner.style.display='none'; return; }
  banner.style.display='flex';
  if (isBusy) {
    banner.className = 'banner';
    banner.innerHTML = `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span class="banner-spacer">${escHtml(lastEvent)}</span>`;
  } else {
    banner.className = 'banner offline';
    banner.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 6.78C3.1 7.86 1.53 9.35.43 11.08M10.71 5.05A10.05 10.05 0 0 1 12 5a10 10 0 0 1 9.29 6.24M16 16a5 5 0 0 1-9.57 1.17m-2.95-1.82A5.06 5.06 0 0 1 12 10a5 5 0 0 1 3.54 1.47M12 19v3"/></svg><span class="banner-spacer">${escHtml(lastEvent)}</span><button class="banner-connect" onclick="handleMainBtn()">Connect</button>`;
  }
}

function renderGrid() {
  const grid  = document.getElementById('device-grid');
  const items = getVisible();
  const isLive = connState==='connected', isBusy = connState==='connecting'||connState==='reconnecting';
  renderBanner();
  if (items.length === 0) {
    const q = (document.getElementById('search-input').value||'').toLowerCase();
    const f = filterState!=='all';
    let title, sub, cta='';
    if (q||f) { title='No devices match'; sub='Clear the search or filter to see all devices.'; }
    else if (isLive||isBusy) { title='Waiting for first stream'; sub='When an Android device starts streaming, its tile appears here automatically.'; }
    else {
      title='Not connected'; sub='Enter your relay URL and connect to see live device screens.';
      cta=`<button class="empty-cta" onclick="handleMainBtn()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9a2 2 0 0 1 0-4h.01M20 9a2 2 0 0 0 0-4h-.01M12 4v2m0 12v2m0-16v2M8 15l-1 1M16 15l1 1M8 9l-1-1M16 9l1-1m-5 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/></svg> Connect relay</button>`;
    }
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="13" x="3" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg><span class="empty-badge"></span></div><h3 class="empty-title">${title}</h3><p class="empty-sub">${sub}</p>${cta}</div>`;
    return;
  }
  grid.className = 'device-grid';
  grid.innerHTML = items.map(d => tileHtml(d)).join('');
  items.forEach(d => {
    const frame = document.querySelector(`[data-tile-id="${escAttr(d.id)}"] .tile-frame`);
    if (frame) attachFrameEvents(frame, d.id);
  });
}

function tileHtml(d) {
  const age    = formatAge(d.lastFrameAt);
  const fps    = d.frameTimes.length>1 ? Math.min(60,Math.round((d.frameTimes.length-1)/15*10)/10).toFixed(1) : '0.0';
  const kb     = d.bytes ? (d.bytes/1024).toFixed(0)+'KB' : '—';
  const sel    = selectedId===d.id;
  const locked = lockedDevices.has(d.id);
  const frozen = frozenDevices.has(d.id);
  const frameContent = d.frame
    ? `<img src="${escAttr(d.frame)}" alt="" draggable="false" />`
    : d.status === 'connected'
      ? `<div class="tile-frame-empty" style="gap:10px;padding:16px;text-align:center;">
           <svg viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="28" height="28"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
           <span style="color:#2563eb;letter-spacing:.06em;">Phone connected</span>
           <span style="font-size:8px;color:#94a3b8;text-transform:none;letter-spacing:0;font-weight:500;line-height:1.5;">Press Start Capture<br/>to begin streaming</span>
         </div>`
      : `<div class="tile-frame-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="13" x="3" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg><span>Awaiting stream</span></div>`;
  return `
  <article class="tile${sel?' selected':''}" data-tile-id="${escAttr(d.id)}">
    <div class="tile-selected-bar"><span>● Controlling</span></div>
    <div class="tile-header">
      <div class="tile-icon ${d.status}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="12" height="20" x="6" y="2" rx="2"/><path d="M12 18h.01"/></svg>
      </div>
      <div class="tile-info" onclick="selectDevice('${escAttr(d.id)}')" title="Click to select for control">
        <div class="tile-id">${escHtml(d.id)}</div>
        <div class="tile-status">
          <span class="tile-status-dot ${d.status}"></span>
          ${statusLabel(d.status)}
        </div>
      </div>
      <div class="tile-actions">
        <!-- Lock / Take-Control button -->
        <button class="tile-action-btn lock-btn${locked?' active':''}" title="${locked?'Release control':'Take control (block phone touch)'}" onclick="toggleLockDevice('${escAttr(d.id)}')">
          ${locked
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`}
        </button>
        <!-- Freeze button -->
        <button class="tile-action-btn freeze-btn${frozen?' active':''}" title="${frozen?'Resume stream':'Freeze screen'}" onclick="toggleFreezeDevice('${escAttr(d.id)}')">
          ${frozen
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`}
        </button>
        <!-- Maximize button -->
        <button class="tile-action-btn" title="Maximize" onclick="openMaximize('${escAttr(d.id)}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
        <!-- Info button -->
        <button class="tile-action-btn" title="Device info" onclick="openInspector('${escAttr(d.id)}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
        </button>
      </div>
    </div>
    <div class="tile-frame" data-frame-id="${escAttr(d.id)}">
      ${frameContent}
      ${frozen ? `<div class="freeze-overlay"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Paused</span></div>` : ''}
      ${locked ? `<div class="lock-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="8" height="8"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> IN CONTROL</div>` : ''}
      <div class="tile-touch-hint" style="${frozen?'display:none':''}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11V6a2 2 0 0 1 4 0v5"/><path d="M13 11V8a2 2 0 0 1 4 0v3"/><path d="M17 11a2 2 0 0 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L8 17V6a2 2 0 0 1 2-2z"/></svg>
        Touch surface
      </div>
    </div>
    <div class="tile-stats">
      <div class="tile-stat"><div class="tile-stat-label">FPS</div><div class="tile-stat-value">${fps}</div></div>
      <div class="tile-stat"><div class="tile-stat-label">Last frame</div><div class="tile-stat-value" data-age-ts="${d.lastFrameAt||''}">${age}</div></div>
      <div class="tile-stat"><div class="tile-stat-label">Size</div><div class="tile-stat-value">${kb}</div></div>
    </div>
    <div style="display:flex;gap:6px;padding:8px 10px;border-top:1px solid #f1f5f9;">
      ${d.status !== 'streaming'
        ? `<button onclick="startCaptureDevice('${escAttr(d.id)}')" style="flex:1;padding:7px 0;border-radius:10px;background:#eff6ff;color:#2563eb;font-size:11px;font-weight:700;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><polygon points="5 3 19 12 5 21 5 3"/></svg>
             Start Capture
           </button>`
        : `<button onclick="stopCaptureDevice('${escAttr(d.id)}')" style="flex:1;padding:7px 0;border-radius:10px;background:#fff1f2;color:#e11d48;font-size:11px;font-weight:700;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
             Stop Capture
           </button>`
      }
      ${d.status === 'streaming'
        ? `<button onclick="toggleFreezeDevice('${escAttr(d.id)}')" title="${frozen?'Resume':'Freeze'}" style="flex:1;padding:7px 0;border-radius:10px;background:${frozen?'#ecfdf5':'#f8fafc'};color:${frozen?'#059669':'#475569'};font-size:11px;font-weight:700;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="11" height="11">${frozen?'<polygon points="5 3 19 12 5 21 5 3"/>':'<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'}</svg>
             ${frozen ? 'Resume' : 'Freeze'}
           </button>`
        : ''
      }
    </div>
  </article>`;
}

function updateTile(id) {
  const el = document.querySelector(`[data-tile-id="${escAttr(id)}"]`);
  if (!el) { renderGrid(); return; }
  const d = devices[id]; if (!d) return;
  const fps = d.frameTimes.length>1 ? Math.min(60,Math.round((d.frameTimes.length-1)/15*10)/10).toFixed(1) : '0.0';
  const kb  = d.bytes ? (d.bytes/1024).toFixed(0)+'KB' : '—';
  // frame
  const frame = el.querySelector('.tile-frame');
  if (frame) {
    const hint = frame.querySelector('.tile-touch-hint');
    const hintHtml = hint ? hint.outerHTML : '';
    const frameContent = d.frame ? `<img src="${escAttr(d.frame)}" alt="" draggable="false" />` : `<div class="tile-frame-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="13" x="3" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg><span>Awaiting stream</span></div>`;
    frame.innerHTML = frameContent + hintHtml;
    attachFrameEvents(frame, id);
  }
  // stats
  const stats = el.querySelectorAll('.tile-stat-value');
  if (stats[0]) stats[0].textContent = fps;
  if (stats[2]) stats[2].textContent = kb;
  const ageEl = el.querySelector('[data-age-ts]');
  if (ageEl) { ageEl.setAttribute('data-age-ts', d.lastFrameAt||''); ageEl.textContent = formatAge(d.lastFrameAt); }
  // status
  const icon = el.querySelector('.tile-icon');
  if (icon) icon.className = `tile-icon ${d.status}`;
  const dot = el.querySelector('.tile-status-dot');
  if (dot) dot.className = `tile-status-dot ${d.status}`;
}

// ── Touch / pointer on tile frames ────────────────────────────────────────────

function attachFrameEvents(frame, id) {
  frame.onpointerdown = (e) => {
    // if (frozenDevices.has(id)) return;           // frozen — ignore gestures
    frame.setPointerCapture(e.pointerId);
    const r = frame.getBoundingClientRect();
    gestureMap.set(e.pointerId, {
      x: Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),
      y: Math.min(1,Math.max(0,(e.clientY-r.top)/r.height)),
      time: Date.now(),
    });
  };
  frame.onpointerup = (e) => {
    const start = gestureMap.get(e.pointerId); gestureMap.delete(e.pointerId);
    // f (!start || frozenDevices.has(id)) return;
    const r    = frame.getBoundingClientRect();
    const ex   = Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));
    const ey   = Math.min(1,Math.max(0,(e.clientY-r.top)/r.height));
    // Cap swipe duration at 300 ms — Android needs a fast stroke to trigger
    // scroll fling momentum. Long user drags (>300 ms hold) still produce a
    // 300 ms gesture which fires RecyclerView/ScrollView fling correctly.
    const dt   = Math.min(300, Math.max(80, Date.now()-start.time));
    const dist = Math.hypot(ex-start.x, ey-start.y);
    if (dist<0.025) { sendMsg({ type:'tap', target:id, x:+ex.toFixed(4), y:+ey.toFixed(4) }); showToast('Tap sent'); }
    else { sendMsg({ type:'swipe', target:id, fromX:+start.x.toFixed(4), fromY:+start.y.toFixed(4), toX:+ex.toFixed(4), toY:+ey.toFixed(4), duration:dt }); showToast('Swipe sent'); }
  };
}

// ── Inspector ─────────────────────────────────────────────────────────────────

function openInspector(id) {
  const d = devices[id]; if (!d) return;
  inspectedId = id;
  const ovl = document.getElementById('inspector-overlay');
  const modal = document.getElementById('inspector-modal');
  const connTime = new Date(d.connectedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  modal.innerHTML = `
    <div class="modal-header">
      <div class="modal-title-wrap">
        <div class="modal-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="12" height="20" x="6" y="2" rx="2"/><path d="M12 18h.01"/></svg></div>
        <div><div class="modal-title">${escHtml(d.id)}</div><div class="modal-subtitle">Device info</div></div>
      </div>
      <button class="modal-close" onclick="closeInspector(null)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
    </div>
    <div class="modal-grid">
      <div class="modal-cell"><div class="modal-cell-label">Status</div><div class="modal-cell-value">${statusLabel(d.status)}</div></div>
      <div class="modal-cell"><div class="modal-cell-label">Last frame</div><div class="modal-cell-value">${formatAge(d.lastFrameAt)}</div></div>
      <div class="modal-cell"><div class="modal-cell-label">Frame size</div><div class="modal-cell-value">${d.bytes?(d.bytes/1024).toFixed(1)+' KB':'—'}</div></div>
      <div class="modal-cell"><div class="modal-cell-label">Connected</div><div class="modal-cell-value">${connTime}</div></div>
    </div>
    <div class="modal-footer">
      <button class="modal-done" style="margin-right:auto" onclick="selectDevice('${escAttr(d.id)}');closeInspector(null)">
        ${selectedId===id ? '✓ Selected' : 'Select for control'}
      </button>
      <button class="modal-done" onclick="closeInspector(null);openMaximize('${escAttr(d.id)}')">Maximize</button>
      <button class="modal-done" style="margin-left:8px" onclick="closeInspector(null)">Done</button>
    </div>`;
  ovl.style.display = 'flex';
}

function closeInspector(e) {
  if (e && e.target !== document.getElementById('inspector-overlay')) return;
  document.getElementById('inspector-overlay').style.display = 'none';
  inspectedId = null;
}

// ── Filter ────────────────────────────────────────────────────────────────────

function toggleFilter() { document.getElementById('filter-dropdown').classList.toggle('open'); }

function setFilter(val, label) {
  filterState = val;
  document.getElementById('filter-label').textContent = label;
  document.querySelectorAll('.filter-opt').forEach(o => o.classList.toggle('active', o.dataset.filter===val));
  document.getElementById('filter-dropdown').classList.remove('open');
  renderGrid();
}

document.addEventListener('click', e => {
  if (!e.target.closest('.filter-wrap')) document.getElementById('filter-dropdown').classList.remove('open');
});

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(msg) {
  const el = document.getElementById('toast');
  document.getElementById('toast-text').textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2000);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('maximize-overlay').classList.contains('open')) closeMaximize();
    else closeInspector(null);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function handleMainBtn() {
  const { url, room } = getInputs();
  try { localStorage.setItem(STORAGE_URL, url); localStorage.setItem(STORAGE_ROOM, room); } catch {}
  connect();
  showToast('Connecting to relay…');
}

function openAccessibility() {
  const a = document.createElement('a');
  a.href = 'intent:#Intent;action=android.settings.ACCESSIBILITY_SETTINGS;end';
  a.click();
  showToast('Open Accessibility Settings');
}

['url-input','room-input'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => { if (e.key==='Enter') handleMainBtn(); });
});

function escHtml(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s)  { return escHtml(s); }
