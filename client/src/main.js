import './style.css';
import { io } from 'socket.io-client';

// Keep in sync with game/room.js on the server (these are just render-side constants).
const WORLD_W = 3000;
const WORLD_H = 2000;
const MULTIPLIER_HALF = 20;
function blockHalfSize(value) {
  return 10 + Math.min(18, Math.log2(value) * 3);
}

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const timerEl = document.getElementById('hud-timer');
const leaderboardEl = document.getElementById('leaderboard');
const boostBtn = document.getElementById('boost-btn');
const toastEl = document.getElementById('toast');

const lobbyOverlay = document.getElementById('lobby-overlay');
const nameInput = document.getElementById('name-input');
const createBtn = document.getElementById('create-btn');
const codeInput = document.getElementById('code-input');
const joinBtn = document.getElementById('join-btn');
const roomInfo = document.getElementById('room-info');
const roomCodeEl = document.getElementById('room-code');
const playerListEl = document.getElementById('player-list');
const startBtn = document.getElementById('start-btn');
const lobbyError = document.getElementById('lobby-error');
const aiCountRow = document.getElementById('ai-count-row');
const aiCountInput = document.getElementById('ai-count-input');
const aiCountReadonly = document.getElementById('ai-count-readonly');
const cancelRoomBtn = document.getElementById('cancel-room-btn');
const cancelIngameBtn = document.getElementById('cancel-ingame-btn');

const overlay = document.getElementById('overlay');
const resultEl = document.getElementById('result');
const rematchBtn = document.getElementById('rematch-btn');

let isHost = false;

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

function fmtTime(t) {
  const m = Math.floor(t / 60).toString().padStart(2, '0');
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

let toastTimer = null;
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 1600);
}

const socket = io({ autoConnect: true });

let currentCode = null;
let latestState = null;

function savedName() {
  return localStorage.getItem('square2048-name') || '';
}
nameInput.value = savedName();

function ackName() {
  const name = nameInput.value.trim() || 'プレイヤー';
  localStorage.setItem('square2048-name', name);
  return name;
}

createBtn.addEventListener('click', () => {
  lobbyError.textContent = '';
  socket.emit('createRoom', ackName(), (res) => {
    if (!res.ok) return (lobbyError.textContent = res.error || '作成できませんでした');
    currentCode = res.code;
  });
});

joinBtn.addEventListener('click', () => {
  lobbyError.textContent = '';
  const code = codeInput.value.trim();
  if (!code) return (lobbyError.textContent = '部屋コードを入力してください');
  socket.emit('joinRoom', code, ackName(), (res) => {
    if (!res.ok) return (lobbyError.textContent = res.error || '参加できませんでした');
    currentCode = res.code;
  });
});

startBtn.addEventListener('click', () => socket.emit('startGame'));
rematchBtn.addEventListener('click', () => {
  overlay.classList.add('hidden');
  lobbyOverlay.classList.remove('hidden');
});
boostBtn.addEventListener('click', () => socket.emit('boost'));

aiCountInput.addEventListener('change', () => {
  socket.emit('setAiCount', Number(aiCountInput.value) || 0);
});
cancelRoomBtn.addEventListener('click', () => socket.emit('cancelRoom'));
cancelIngameBtn.addEventListener('click', () => socket.emit('cancelRoom'));

socket.on('lobby', (state) => {
  currentCode = state.code;
  isHost = state.hostId === socket.id;
  roomInfo.classList.remove('hidden');
  roomCodeEl.textContent = state.code;
  playerListEl.innerHTML = state.players
    .map((p) => `<li>${p.id === socket.id ? '★ ' : ''}${p.name}${p.id === state.hostId ? '（ホスト）' : ''}</li>`)
    .join('');
  startBtn.disabled = state.players.length < 1;

  const maxBots = Math.max(0, state.maxPlayers - state.players.length);
  if (isHost) {
    aiCountRow.classList.remove('hidden');
    aiCountReadonly.classList.add('hidden');
    aiCountInput.max = maxBots;
    if (Number(aiCountInput.value) !== state.aiCount) aiCountInput.value = state.aiCount;
    cancelRoomBtn.classList.remove('hidden');
  } else {
    aiCountRow.classList.add('hidden');
    aiCountReadonly.classList.remove('hidden');
    aiCountReadonly.textContent = `AI: ${state.aiCount}体（ホストが設定）`;
    cancelRoomBtn.classList.add('hidden');
  }
  cancelIngameBtn.classList.toggle('hidden', !(isHost && state.running));
});

socket.on('started', () => {
  lobbyOverlay.classList.add('hidden');
  overlay.classList.add('hidden');
  cancelIngameBtn.classList.toggle('hidden', !isHost);
});

socket.on('cancelled', () => {
  cancelIngameBtn.classList.add('hidden');
  overlay.classList.add('hidden');
  lobbyOverlay.classList.remove('hidden');
  showToast('対戦を中止しました');
});

socket.on('state', (state) => {
  latestState = state;
});

socket.on('toast', (text) => showToast(text));

socket.on('gameOver', (standings) => {
  const lines = standings
    .map(
      (s, i) =>
        `${i + 1}. ${s.id === socket.id ? '★ ' : ''}${s.isBot ? '🤖 ' : ''}${s.name} — 🏆${s.trophies} 💀${s.eatenCount}`,
    )
    .join('<br />');
  resultEl.innerHTML = lines;
  overlay.classList.remove('hidden');
});

// Keyboard input
const keys = { up: false, down: false, left: false, right: false };
const KEY_MAP = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
};
window.addEventListener('keydown', (e) => {
  if (KEY_MAP[e.code]) {
    keys[KEY_MAP[e.code]] = true;
    socket.emit('input', keys);
  }
  if (e.code === 'Space' && !e.repeat) socket.emit('boost');
});
window.addEventListener('keyup', (e) => {
  if (KEY_MAP[e.code]) {
    keys[KEY_MAP[e.code]] = false;
    socket.emit('input', keys);
  }
});

// Touch/drag steering, same convention as the solo version: the pointer's
// offset from screen center (where "my" snake is drawn) gives the direction.
let activePointerId = null;
function pointerToAngle(e) {
  const rect = canvas.getBoundingClientRect();
  const dx = e.clientX - rect.left - canvas.width / 2;
  const dy = e.clientY - rect.top - canvas.height / 2;
  return Math.atan2(dy, dx);
}
canvas.addEventListener('pointerdown', (e) => {
  activePointerId = e.pointerId;
  socket.emit('pointer', pointerToAngle(e));
});
canvas.addEventListener('pointermove', (e) => {
  if (activePointerId !== e.pointerId) return;
  socket.emit('pointer', pointerToAngle(e));
});
function releasePointer(e) {
  if (activePointerId !== e.pointerId) return;
  activePointerId = null;
  socket.emit('clearPointer');
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);

function drawGrid(camX, camY) {
  const step = 100;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  const startX = Math.floor((camX - canvas.width / 2) / step) * step;
  const startY = Math.floor((camY - canvas.height / 2) / step) * step;
  for (let x = startX; x < camX + canvas.width / 2; x += step) {
    const sx = x - camX + canvas.width / 2;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, canvas.height);
    ctx.stroke();
  }
  for (let y = startY; y < camY + canvas.height / 2; y += step) {
    const sy = y - camY + canvas.height / 2;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(canvas.width, sy);
    ctx.stroke();
  }
}

function drawBlock(px, py, value, half, fill, textColor = '#1a1c2c') {
  const side = half * 2;
  ctx.beginPath();
  ctx.roundRect(px - half, py - half, side, side, Math.min(6, half * 0.3));
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.font = `${Math.max(10, half * 0.8)}px sans-serif`;
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(value, px, py + 1);
}

function drawFloor(f, camX, camY) {
  const sx = f.x - camX + canvas.width / 2;
  const sy = f.y - camY + canvas.height / 2;
  if (sx < -f.w || sx > canvas.width + f.w || sy < -f.h || sy > canvas.height + f.h) return;
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = f.color;
  ctx.beginPath();
  ctx.roundRect(sx - f.w / 2, sy - f.h / 2, f.w, f.h, 14);
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = f.color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  ctx.font = 'bold 22px sans-serif';
  ctx.fillStyle = f.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text =
    f.type === 'speed' ? `⚡ ${f.label}` : f.type === 'quad' ? `x4: ${f.label}` : `x2: ${f.label}`;
  ctx.fillText(text, sx, sy);
}

function render() {
  ctx.fillStyle = '#23263a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!latestState) return;
  const mine = latestState.snakes.find((s) => s.id === socket.id);
  const cam = mine && mine.alive ? mine : null;
  const camX = cam ? cam.x : WORLD_W / 2;
  const camY = cam ? cam.y : WORLD_H / 2;

  drawGrid(camX, camY);

  const toScreen = (x, y) => ({
    x: x - camX + canvas.width / 2,
    y: y - camY + canvas.height / 2,
  });

  const tl = toScreen(0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 3;
  ctx.strokeRect(tl.x, tl.y, WORLD_W, WORLD_H);

  for (const f of latestState.floors) drawFloor(f, camX, camY);

  for (const b of latestState.blocks) {
    const p = toScreen(b.x, b.y);
    if (p.x < -30 || p.x > canvas.width + 30 || p.y < -30 || p.y > canvas.height + 30) continue;
    if (b.kind === 'multiplier') {
      const fill = b.op === 'x2' ? '#ffd54a' : b.op === 'x3' ? '#fb923c' : '#60a5fa';
      const label = b.op === 'x2' ? '×2' : b.op === 'x3' ? '×3' : '÷2';
      drawBlock(p.x, p.y, label, MULTIPLIER_HALF, fill);
    } else {
      drawBlock(p.x, p.y, b.value, blockHalfSize(b.value), '#8b93b8');
    }
  }

  for (const s of latestState.snakes) {
    if (!s.alive) continue;
    if (s.invincible) ctx.globalAlpha = 0.5 + 0.4 * Math.sin(performance.now() / 90);
    for (let i = s.segments.length - 1; i >= 0; i--) {
      const seg = s.segments[i];
      const p = toScreen(seg.x, seg.y);
      drawBlock(p.x, p.y, seg.value, blockHalfSize(seg.value), s.color, '#12131c');
    }
    ctx.globalAlpha = 1;
    const headPos = toScreen(s.x, s.y);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    const label = `${s.isBot ? '🤖 ' : ''}${s.invincible ? '🛡️ ' : ''}${s.name}`;
    ctx.fillText(label, headPos.x, headPos.y - blockHalfSize(s.headValue) - 10);
  }
}

function updateHud() {
  if (!latestState) return;
  timerEl.textContent = fmtTime(Math.max(0, latestState.timeLeft));

  const mine = latestState.snakes.find((s) => s.id === socket.id);
  if (mine) {
    const cooldownLeft = Math.max(0, (mine.boostReadyAt ?? 0) - Date.now());
    if (cooldownLeft > 0) {
      boostBtn.disabled = true;
      boostBtn.textContent = `⚡ ${Math.ceil(cooldownLeft / 1000)}`;
    } else {
      boostBtn.disabled = false;
      boostBtn.textContent = '⚡ ブースト';
    }
  }

  const mySum = mine ? (mine.alive ? mine.sum : 0) : 0;
  leaderboardEl.innerHTML = `<h3>リーダーボード</h3><ol>${latestState.standings
    .slice(0, 6)
    .map(
      (s) =>
        `<li class="${s.id === socket.id ? 'me' : ''}">${s.isBot ? '🤖 ' : ''}${s.name} 🏆${s.trophies} 💀${s.eatenCount}</li>`,
    )
    .join('')}</ol><div id="my-value">${mySum}</div>`;
}

function loop() {
  render();
  updateHud();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
