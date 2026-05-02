// Browsert RTS - simple multiplayer browser RTS.
// One AI faction (red) plus up to 6 humans, free-for-all. Trystero/WebRTC peer-to-peer,
// authority elected by lowest peer id. No server code.

const CANVAS_W = 1024;
const CANVAS_H = 640;
const SOLDIER_RADIUS = 10;
const SEPARATION_R = 22;
const SOLDIER_SPEED = 60;
const SOLDIER_HP = 50;
const ATTACK_RANGE = 30;
const ATTACK_DAMAGE = 8;
const ATTACK_COOLDOWN = 0.6;
const NET_HZ = 15;
const SOLDIERS_PER_PLAYER = 10;
const PALETTE = ['#3b82f6', '#22c55e', '#eab308', '#a855f7', '#06b6d4', '#f97316'];
const AI_COLOR = '#ef4444';
const AI_ID = 'AI';
const ROOM_DEFAULT = 'browsert-rts-default';

// --- DOM ---
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const countsEl = document.getElementById('counts');
const roomEl = document.getElementById('room');
const statusEl = document.getElementById('status');
const bannerEl = document.getElementById('banner');

const roomId = location.hash.slice(1) || ROOM_DEFAULT;
roomEl.textContent = `Room: ${roomId}`;

// --- Networking ---
let selfId = null;
let sendCmd = () => {};
let sendState = () => {};
const peers = new Set();

let onCmdHandler = () => {};
let onStateHandler = () => {};

async function setupNet() {
  try {
    const mod = await import('https://esm.sh/trystero@0.20.0/torrent');
    const { joinRoom, selfId: sid } = mod;
    selfId = sid;
    peers.add(selfId);

    const room = joinRoom({ appId: 'browsert-rts' }, roomId);
    const [_sendCmd, _onCmd] = room.makeAction('cmd');
    const [_sendState, _onState] = room.makeAction('state');
    sendCmd = _sendCmd;
    sendState = _sendState;
    _onCmd((d, id) => onCmdHandler(d, id));
    _onState((d, id) => onStateHandler(d, id));
    room.onPeerJoin(id => {
      peers.add(id);
      onPeersChanged('join', id);
    });
    room.onPeerLeave(id => {
      peers.delete(id);
      onPeersChanged('leave', id);
    });
    statusEl.dataset.mode = 'online';
  } catch (err) {
    console.warn('Trystero unavailable, running offline:', err);
    selfId = 'local-' + Math.random().toString(36).slice(2, 10);
    peers.add(selfId);
    statusEl.dataset.mode = 'offline';
  }
  onPeersChanged('init', selfId);
}

function lowestPeerId() {
  let lo = null;
  for (const id of peers) if (lo === null || id < lo) lo = id;
  return lo;
}

// --- World state (host owns) ---
let isHost = false;
let wasHost = false;
let nextSoldierId = 1;

const world = {
  players: new Map(), // id -> { color }
  soldiers: [],       // {id, owner, x, y, hp, target, attackTarget, cooldown}
  gameOver: null,
};

let lastSnapshot = null;
const cmdQueue = [];

function onPeersChanged(reason, id) {
  isHost = lowestPeerId() === selfId;

  if (isHost && !wasHost) seedHostFromView();
  wasHost = isHost;

  if (!isHost) return;

  if (reason === 'init') {
    ensureAI();
    ensurePlayer(selfId);
  } else if (reason === 'join') {
    ensurePlayer(id);
  } else if (reason === 'leave') {
    removePlayer(id);
  }
}

function seedHostFromView() {
  if (world.soldiers.length === 0 && lastSnapshot) {
    world.players.clear();
    if (lastSnapshot.players) {
      for (const p of lastSnapshot.players) world.players.set(p.id, { color: p.color });
    }
    world.soldiers = (lastSnapshot.soldiers || []).map(s => ({
      id: s.id, owner: s.owner, x: s.x, y: s.y, hp: s.hp,
      target: null, attackTarget: null, cooldown: 0,
    }));
    nextSoldierId = world.soldiers.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    world.gameOver = lastSnapshot.gameOver || null;
  }
  ensureAI();
}

function ensureAI() {
  if (world.players.has(AI_ID)) return;
  world.players.set(AI_ID, { color: AI_COLOR });
  spawnSoldiersFor(AI_ID, { x: CANVAS_W - 80, y: CANVAS_H / 2 });
}

function ensurePlayer(id) {
  if (id === AI_ID || world.players.has(id)) return;
  const color = nextFreeColor();
  if (!color) {
    world.players.set(id, { color: null });
    return;
  }
  world.players.set(id, { color });
  const isFirstHuman = !anyHumanHasSoldiers();
  const spawn = isFirstHuman ? { x: 80, y: CANVAS_H / 2 } : findSpawnPoint();
  spawnSoldiersFor(id, spawn);
}

function anyHumanHasSoldiers() {
  for (const s of world.soldiers) if (s.owner !== AI_ID) return true;
  return false;
}

function removePlayer(id) {
  world.players.delete(id);
  world.soldiers = world.soldiers.filter(s => s.owner !== id);
}

function nextFreeColor() {
  const used = new Set();
  for (const [, p] of world.players) if (p.color) used.add(p.color);
  for (const c of PALETTE) if (!used.has(c)) return c;
  return null;
}

function spawnSoldiersFor(ownerId, center) {
  const offsets = formationOffsets(SOLDIERS_PER_PLAYER);
  for (const [dx, dy] of offsets) {
    world.soldiers.push({
      id: nextSoldierId++,
      owner: ownerId,
      x: clamp(center.x + dx, SOLDIER_RADIUS, CANVAS_W - SOLDIER_RADIUS),
      y: clamp(center.y + dy, SOLDIER_RADIUS, CANVAS_H - SOLDIER_RADIUS),
      hp: SOLDIER_HP,
      target: null,
      attackTarget: null,
      cooldown: 0,
    });
  }
  // Joining a player resets a previous victory state so the match continues.
  world.gameOver = null;
}

function formationOffsets(n) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    out.push([
      (c - (cols - 1) / 2) * SEPARATION_R,
      (r - (rows - 1) / 2) * SEPARATION_R,
    ]);
  }
  return out;
}

function findSpawnPoint() {
  const alive = world.soldiers;
  let cx = CANVAS_W / 2, cy = CANVAS_H / 2;
  if (alive.length > 0) {
    cx = alive.reduce((a, s) => a + s.x, 0) / alive.length;
    cy = alive.reduce((a, s) => a + s.y, 0) / alive.length;
  }
  const inset = 80;
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * Math.PI * 2;
    const p = {
      x: CANVAS_W / 2 + Math.cos(t) * (CANVAS_W / 2 - inset),
      y: CANVAS_H / 2 + Math.sin(t) * (CANVAS_H / 2 - inset),
    };
    let minDistS = Infinity;
    for (const s of alive) {
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d < minDistS) minDistS = d;
    }
    const distC = Math.hypot(p.x - cx, p.y - cy);
    const score = (minDistS >= 200 ? 1000 : 0) + distC;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best || { x: CANVAS_W / 2, y: CANVAS_H / 2 };
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// --- Command handling ---
onCmdHandler = (msg, fromId) => {
  if (!isHost || !msg || msg.kind !== 'move') return;
  cmdQueue.push({ fromId, msg });
};

function applyPendingCommands() {
  while (cmdQueue.length > 0) {
    const { fromId, msg } = cmdQueue.shift();
    if (!msg.target) continue;
    const wanted = new Set(msg.ids);
    const matches = world.soldiers.filter(s => s.owner === fromId && wanted.has(s.id));
    const offsets = formationOffsets(matches.length);
    matches.forEach((s, i) => {
      const [dx, dy] = offsets[i] || [0, 0];
      s.target = {
        x: clamp(msg.target.x + dx, SOLDIER_RADIUS, CANVAS_W - SOLDIER_RADIUS),
        y: clamp(msg.target.y + dy, SOLDIER_RADIUS, CANVAS_H - SOLDIER_RADIUS),
      };
      s.attackTarget = null;
    });
  }
}

// --- Simulation (host only) ---
let lastTick = performance.now();
let aiRetargetAccum = 0;

function simulationStep(now) {
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;
  if (!isHost) return;

  applyPendingCommands();

  aiRetargetAccum += dt;
  if (aiRetargetAccum >= 1) {
    aiRetargetAccum = 0;
    aiRetarget();
  }

  updateMovement(dt);
  applySeparation();
  updateCombat(dt);
  checkWin();
}

function aiRetarget() {
  for (const s of world.soldiers) {
    if (s.owner !== AI_ID) continue;
    let best = null, bd = Infinity;
    for (const t of world.soldiers) {
      if (t.owner === AI_ID) continue;
      const d = (t.x - s.x) ** 2 + (t.y - s.y) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    if (best) s.target = { x: best.x, y: best.y };
  }
}

function updateMovement(dt) {
  for (const s of world.soldiers) {
    if (!s.target) continue;
    const dx = s.target.x - s.x;
    const dy = s.target.y - s.y;
    const d = Math.hypot(dx, dy);
    if (d < 1.5) { s.target = null; continue; }
    const step = SOLDIER_SPEED * dt;
    if (step >= d) {
      s.x = s.target.x; s.y = s.target.y; s.target = null;
    } else {
      s.x += (dx / d) * step;
      s.y += (dy / d) * step;
    }
  }
}

function applySeparation() {
  const arr = world.soldiers;
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < SEPARATION_R * SEPARATION_R && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const push = (SEPARATION_R - d) * 0.5;
        const ux = dx / d, uy = dy / d;
        a.x -= ux * push * 0.5;
        a.y -= uy * push * 0.5;
        b.x += ux * push * 0.5;
        b.y += uy * push * 0.5;
      }
    }
  }
  for (const s of arr) {
    s.x = clamp(s.x, SOLDIER_RADIUS, CANVAS_W - SOLDIER_RADIUS);
    s.y = clamp(s.y, SOLDIER_RADIUS, CANVAS_H - SOLDIER_RADIUS);
  }
}

function updateCombat(dt) {
  const byId = new Map();
  for (const s of world.soldiers) byId.set(s.id, s);

  for (const s of world.soldiers) {
    s.cooldown = Math.max(0, s.cooldown - dt);

    if (s.attackTarget != null) {
      const t = byId.get(s.attackTarget);
      if (!t || t.hp <= 0 || dist(s, t) > ATTACK_RANGE) s.attackTarget = null;
    }
    if (s.attackTarget == null) {
      let best = null, bd = (ATTACK_RANGE * 1.5) ** 2;
      for (const t of world.soldiers) {
        if (t === s || t.owner === s.owner || t.hp <= 0) continue;
        const d2 = (t.x - s.x) ** 2 + (t.y - s.y) ** 2;
        if (d2 < bd) { bd = d2; best = t; }
      }
      if (best) s.attackTarget = best.id;
    }
    if (s.attackTarget != null && s.cooldown === 0) {
      const t = byId.get(s.attackTarget);
      if (t && dist(s, t) <= ATTACK_RANGE) {
        t.hp -= ATTACK_DAMAGE;
        s.cooldown = ATTACK_COOLDOWN;
      }
    }
  }
  world.soldiers = world.soldiers.filter(s => s.hp > 0);
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function checkWin() {
  if (world.gameOver) return;
  const teams = new Set();
  for (const s of world.soldiers) teams.add(s.owner);
  if (world.players.size > 1 && teams.size <= 1) {
    const winner = [...teams][0] || null;
    const color = winner ? (world.players.get(winner)?.color || AI_COLOR) : null;
    world.gameOver = { winnerId: winner, winnerColor: color };
  }
}

// --- Snapshot ---
function buildSnapshot() {
  return {
    t: performance.now(),
    players: [...world.players].map(([id, p]) => ({ id, color: p.color })),
    soldiers: world.soldiers.map(s => ({
      id: s.id, owner: s.owner, x: Math.round(s.x), y: Math.round(s.y), hp: s.hp,
    })),
    gameOver: world.gameOver,
  };
}

function broadcastSnapshot() {
  if (!isHost) return;
  const snap = buildSnapshot();
  lastSnapshot = snap;
  sendState(snap);
}

onStateHandler = (snap, fromId) => {
  if (isHost) return;
  if (fromId !== lowestPeerId()) return;
  lastSnapshot = snap;
};

// --- Input / view ---
const selected = new Set();
let dragStart = null, dragEnd = null;
let mouseDown = false;

function getMouse(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (CANVAS_W / rect.width),
    y: (e.clientY - rect.top) * (CANVAS_H / rect.height),
  };
}

function viewSoldiers() {
  if (isHost) {
    return world.soldiers.map(s => ({
      id: s.id, owner: s.owner, x: s.x, y: s.y, hp: s.hp,
    }));
  }
  return lastSnapshot ? lastSnapshot.soldiers : [];
}
function viewPlayers() {
  if (isHost) return [...world.players].map(([id, p]) => ({ id, color: p.color }));
  return lastSnapshot ? lastSnapshot.players : [];
}
function viewGameOver() {
  return isHost ? world.gameOver : (lastSnapshot ? lastSnapshot.gameOver : null);
}

function soldierAt(p) {
  for (const s of viewSoldiers()) {
    if (Math.hypot(s.x - p.x, s.y - p.y) <= SOLDIER_RADIUS + 2) return s;
  }
  return null;
}

canvas.addEventListener('mousedown', e => {
  const m = getMouse(e);
  if (e.button === 0) {
    mouseDown = true;
    dragStart = m;
    dragEnd = m;
  } else if (e.button === 2) {
    issueMove(m);
  }
});

canvas.addEventListener('mousemove', e => {
  if (mouseDown) dragEnd = getMouse(e);
});

canvas.addEventListener('mouseup', e => {
  if (e.button !== 0) return;
  mouseDown = false;
  if (!dragStart || !dragEnd) { dragStart = dragEnd = null; return; }
  const drag = Math.hypot(dragEnd.x - dragStart.x, dragEnd.y - dragStart.y);
  if (!e.shiftKey) selected.clear();
  if (drag < 4) {
    const s = soldierAt(dragEnd);
    if (s && s.owner === selfId) selected.add(s.id);
  } else {
    const x1 = Math.min(dragStart.x, dragEnd.x);
    const y1 = Math.min(dragStart.y, dragEnd.y);
    const x2 = Math.max(dragStart.x, dragEnd.x);
    const y2 = Math.max(dragStart.y, dragEnd.y);
    for (const s of viewSoldiers()) {
      if (s.owner !== selfId) continue;
      if (s.x >= x1 && s.x <= x2 && s.y >= y1 && s.y <= y2) selected.add(s.id);
    }
  }
  dragStart = dragEnd = null;
});

canvas.addEventListener('contextmenu', e => e.preventDefault());

window.addEventListener('mouseup', e => {
  if (e.button === 0) mouseDown = false;
});

function issueMove(p) {
  if (selected.size === 0) return;
  const owned = new Set(viewSoldiers().filter(s => s.owner === selfId).map(s => s.id));
  const ids = [...selected].filter(id => owned.has(id));
  if (ids.length === 0) return;
  const msg = { kind: 'move', ids, target: { x: p.x, y: p.y } };
  if (isHost) {
    cmdQueue.push({ fromId: selfId, msg });
  } else {
    sendCmd(msg, lowestPeerId());
  }
}

// --- Render ---
function render() {
  ctx.fillStyle = '#1f3a1f';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const players = viewPlayers();
  const colorById = new Map(players.map(p => [p.id, p.color]));
  const soldiers = viewSoldiers();

  for (const s of soldiers) {
    if (selected.has(s.id)) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, SOLDIER_RADIUS + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  for (const s of soldiers) {
    const color = colorById.get(s.owner) || '#888';
    ctx.beginPath();
    ctx.arc(s.x, s.y, SOLDIER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    const w = 18, h = 3;
    const ratio = Math.max(0, s.hp) / SOLDIER_HP;
    ctx.fillStyle = '#222';
    ctx.fillRect(s.x - w / 2, s.y - SOLDIER_RADIUS - 7, w, h);
    ctx.fillStyle = ratio > 0.5 ? '#22c55e' : ratio > 0.25 ? '#eab308' : '#ef4444';
    ctx.fillRect(s.x - w / 2, s.y - SOLDIER_RADIUS - 7, w * ratio, h);
  }

  if (dragStart && dragEnd) {
    const drag = Math.hypot(dragEnd.x - dragStart.x, dragEnd.y - dragStart.y);
    if (drag >= 4) {
      const x = Math.min(dragStart.x, dragEnd.x);
      const y = Math.min(dragStart.y, dragEnd.y);
      const w = Math.abs(dragEnd.x - dragStart.x);
      const h = Math.abs(dragEnd.y - dragStart.y);
      ctx.fillStyle = 'rgba(255, 224, 102, 0.12)';
      ctx.fillRect(x, y, w, h);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
  }

  renderHUD(soldiers, players);

  const go = viewGameOver();
  if (go) {
    bannerEl.classList.remove('hidden');
    if (go.winnerId === selfId) bannerEl.textContent = 'You win!';
    else if (go.winnerId == null) bannerEl.textContent = 'Draw';
    else if (go.winnerId === AI_ID) bannerEl.textContent = 'AI wins';
    else bannerEl.textContent = 'You lose';
    bannerEl.style.color = go.winnerColor || 'white';
  } else {
    bannerEl.classList.add('hidden');
  }
}

function renderHUD(soldiers, players) {
  const counts = new Map();
  for (const s of soldiers) counts.set(s.owner, (counts.get(s.owner) || 0) + 1);

  const ordered = [...players].sort((a, b) => {
    if (a.id === selfId) return -1;
    if (b.id === selfId) return 1;
    if (a.id === AI_ID) return -1;
    if (b.id === AI_ID) return 1;
    return a.id.localeCompare(b.id);
  });

  const frags = ordered.map(p => {
    const n = counts.get(p.id) || 0;
    const label =
      p.id === AI_ID ? 'AI' :
      p.id === selfId ? `You (${shortId(p.id)})` :
      shortId(p.id);
    const cls = 'count-chip' + (p.id === selfId ? ' you' : '');
    return `<span class="${cls}"><span class="swatch" style="background:${p.color || '#666'}"></span><span>${label}: ${n}</span></span>`;
  });
  countsEl.innerHTML = frags.join('');

  const mode = statusEl.dataset.mode === 'offline' ? 'Offline' : (isHost ? 'Host' : 'Client');
  statusEl.textContent = `${mode} · ${peers.size} peer${peers.size === 1 ? '' : 's'}`;
}

function shortId(id) { return id.slice(0, 4); }

// --- Main loops ---
function frame() {
  simulationStep(performance.now());
  render();
  requestAnimationFrame(frame);
}

setInterval(broadcastSnapshot, 1000 / NET_HZ);

setupNet().then(() => {
  requestAnimationFrame(frame);
});
