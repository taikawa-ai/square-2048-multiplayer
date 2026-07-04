// Server-authoritative simulation for one room of up to MAX_PLAYERS humans.
// Ported from the solo game's engine, adapted to run without a DOM: every
// snake here is a real connected player (no AI bots), driven by input events
// pushed in from socket messages instead of window key listeners.

export const MAX_PLAYERS = 6;
export const WORLD_W = 3000;
export const WORLD_H = 2000;
export const GAME_DURATION = 300; // seconds

const RESPAWN_DELAY = 3000; // ms
const BASE_SPEED = 160 * 1.3; // px/sec
const TURN_RATE = Math.PI * 2.2; // rad/sec
const SEGMENT_GAP = 6;
const HIT_MARGIN = 6;
const MULTIPLIER_HALF = 20;
const INITIAL_SUM = 32;
const MIN_RESPAWN_VALUE = 2;
const NUM_FLOORS = 5;
const FLOOR_SIZE = 180;
const FLOOR_RESPAWN_MIN = 6000;
const FLOOR_RESPAWN_MAX = 12000;
const BOOST_MULTIPLIER = 1.9;
const FLOOR_BOOST_DURATION = 2500;
const BUTTON_BOOST_DURATION = 2000;
const BUTTON_BOOST_COOLDOWN = 8000;
const FRENZY_TIME_LEFT = 90;
const TRIPLER_CHANCE = 0.05;
const INVINCIBLE_DURATION = 2500;
const NUM_FLOATING_BLOCKS = 45;

export function blockHalfSize(value) {
  return 10 + Math.min(18, Math.log2(value) * 3);
}

function squareOverlap(ax, ay, aHalf, bx, by, bHalf, margin = 0) {
  const dx = ax - bx;
  const dy = ay - by;
  const ox = aHalf + bHalf + margin - Math.abs(dx);
  const oy = aHalf + bHalf + margin - Math.abs(dy);
  if (ox <= 0 || oy <= 0) return null;
  return { ox, oy, dx, dy };
}

const BLOCK_WEIGHTS = [
  { value: 1, weight: 30 },
  { value: 2, weight: 26 },
  { value: 4, weight: 20 },
  { value: 8, weight: 12 },
  { value: 16, weight: 7 },
  { value: 32, weight: 3 },
  { value: 64, weight: 1 },
  { value: 128, weight: 0.3 },
];

const FRENZY_BLOCK_WEIGHTS = [
  { value: 128, weight: 3 },
  { value: 256, weight: 1.5 },
];

const MULTIPLIER_CHANCE = 0.06;
const DIVIDER_CHANCE = 0.06;

function isPrime(n) {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let i = 3; i * i <= n; i += 2) if (n % i === 0) return false;
  return true;
}

const FLOOR_DEFS = [
  { type: 'double', label: '素数', color: '#ff6b6b', test: (n) => isPrime(n) },
  { type: 'double', label: '3の倍数', color: '#4fd3c4', test: (n) => n % 3 === 0 },
  { type: 'double', label: '4の倍数', color: '#7c83fd', test: (n) => n % 4 === 0 },
  { type: 'double', label: '5の倍数', color: '#ffd54a', test: (n) => n % 5 === 0 },
  { type: 'double', label: '7の倍数', color: '#69db7c', test: (n) => n % 7 === 0 },
  { type: 'double', label: '奇数', color: '#e879f9', test: (n) => n % 2 === 1 },
  { type: 'speed', label: 'ダッシュ', color: '#38bdf8' },
];

const FRENZY_FLOOR_DEFS = [
  { type: 'quad', label: '素数', color: '#f43f5e', test: (n) => isPrime(n) },
  { type: 'quad', label: '3の倍数', color: '#f43f5e', test: (n) => n % 3 === 0 },
  { type: 'quad', label: '偶数', color: '#f43f5e', test: (n) => n % 2 === 0 },
];

export const COLORS = ['#4fd3c4', '#ff6b6b', '#ffd54a', '#7c83fd', '#ff9f6b', '#69db7c'];

function pickWeightedValue(frenzy) {
  const weights = frenzy ? BLOCK_WEIGHTS.concat(FRENZY_BLOCK_WEIGHTS) : BLOCK_WEIGHTS;
  const total = weights.reduce((s, b) => s + b.weight, 0);
  let r = Math.random() * total;
  for (const b of weights) {
    if (r < b.weight) return b.value;
    r -= b.weight;
  }
  return 1;
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function bitsOf(n) {
  const bits = [];
  for (let p = 1024; p >= 1; p /= 2) {
    if (n & p) bits.push(p);
  }
  return bits;
}

function chainSpan(chain) {
  let span = 0;
  for (let i = 1; i < chain.length; i++) {
    span += blockHalfSize(chain[i - 1]) + blockHalfSize(chain[i]) + SEGMENT_GAP;
  }
  return span;
}

class Snake {
  constructor(id, name, color) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.trophies = 0;
    this.eatenCount = 0;
    this.keys = { up: false, down: false, left: false, right: false };
    this.pointerActive = false;
    this.pointerAngle = 0;
    this.spawn();
  }

  spawn(sum = INITIAL_SUM) {
    this.x = randRange(200, WORLD_W - 200);
    this.y = randRange(200, WORLD_H - 200);
    this.angle = Math.random() * Math.PI * 2;
    this.desiredAngle = this.angle;
    this.sum = sum;
    this.path = [{ x: this.x, y: this.y }];
    this.alive = true;
    this.respawnAt = 0;
    this.boostUntil = 0;
    this.boostReadyAt = 0;
    this.invincibleUntil = Date.now() + INVINCIBLE_DURATION;
  }

  get isInvincible() {
    return Date.now() < this.invincibleUntil;
  }

  get chain() {
    return bitsOf(this.sum);
  }

  get headValue() {
    return this.chain[0];
  }

  segmentPositions() {
    const chain = this.chain;
    const positions = [];
    let dist = 0;
    let pi = this.path.length - 1;
    let prev = this.path[pi];
    let cumulative = 0;
    for (let i = 0; i < chain.length; i++) {
      if (i > 0) {
        cumulative += blockHalfSize(chain[i - 1]) + blockHalfSize(chain[i]) + SEGMENT_GAP;
      }
      while (dist < cumulative && pi > 0) {
        pi--;
        const cur = this.path[pi];
        dist += Math.hypot(cur.x - prev.x, cur.y - prev.y);
        prev = cur;
      }
      positions.push({ x: prev.x, y: prev.y, value: chain[i] });
    }
    return positions;
  }
}

export class Room {
  constructor(code, { onMessage, onEnd } = {}) {
    this.code = code;
    this.onMessage = onMessage; // (snakeId, text) => void
    this.onEnd = onEnd; // (standings) => void
    this.snakes = new Map(); // id -> Snake
    this.blocks = [];
    this.floors = [];
    this.timeLeft = GAME_DURATION;
    this.running = false;
    this.frenzyActive = false;
    this._nextId = 1;
    this._timeouts = new Set();
  }

  _setTimeout(fn, ms) {
    const t = setTimeout(() => {
      this._timeouts.delete(t);
      fn();
    }, ms);
    this._timeouts.add(t);
    return t;
  }

  destroy() {
    for (const t of this._timeouts) clearTimeout(t);
    this._timeouts.clear();
  }

  addPlayer(id, name) {
    if (this.snakes.has(id)) return this.snakes.get(id);
    const color = COLORS[this.snakes.size % COLORS.length];
    const snake = new Snake(id, name, color);
    snake.alive = this.running; // joiners mid-round wait for the next tick to appear
    this.snakes.set(id, snake);
    return snake;
  }

  removePlayer(id) {
    this.snakes.delete(id);
  }

  get playerCount() {
    return this.snakes.size;
  }

  setInput(id, keys) {
    const s = this.snakes.get(id);
    if (!s) return;
    s.pointerActive = false;
    Object.assign(s.keys, keys);
  }

  setPointerAngle(id, angle) {
    const s = this.snakes.get(id);
    if (!s) return;
    s.pointerActive = true;
    s.pointerAngle = angle;
  }

  clearPointer(id) {
    const s = this.snakes.get(id);
    if (!s) return;
    s.pointerActive = false;
  }

  triggerBoost(id) {
    const s = this.snakes.get(id);
    if (!s || !s.alive) return;
    const now = Date.now();
    if (now < (s.boostReadyAt || 0)) return;
    this._applyBoost(s, BUTTON_BOOST_DURATION);
    s.boostReadyAt = now + BUTTON_BOOST_COOLDOWN;
  }

  start() {
    this.timeLeft = GAME_DURATION;
    this.running = true;
    this.frenzyActive = false;
    this.blocks = [];
    this.floors = [];
    for (const s of this.snakes.values()) {
      s.trophies = 0;
      s.eatenCount = 0;
      s.spawn();
    }
    for (let i = 0; i < NUM_FLOATING_BLOCKS; i++) this._spawnBlock();
    for (let i = 0; i < NUM_FLOORS; i++) this._spawnFloor();
  }

  _spawnFloor() {
    const pool = this.frenzyActive ? FLOOR_DEFS.concat(FRENZY_FLOOR_DEFS) : FLOOR_DEFS;
    const def = pool[Math.floor(Math.random() * pool.length)];
    this.floors.push({
      id: this._nextId++,
      ...def,
      x: randRange(300, WORLD_W - 300),
      y: randRange(300, WORLD_H - 300),
      w: FLOOR_SIZE,
      h: FLOOR_SIZE,
    });
  }

  _consumeFloor(index) {
    this.floors.splice(index, 1);
    this._setTimeout(() => this._spawnFloor(), randRange(FLOOR_RESPAWN_MIN, FLOOR_RESPAWN_MAX));
  }

  _maybeStartFrenzy() {
    if (this.frenzyActive || this.timeLeft > FRENZY_TIME_LEFT) return;
    this.frenzyActive = true;
    for (let i = 0; i < 3; i++) {
      this.floors.push({
        id: this._nextId++,
        ...FRENZY_FLOOR_DEFS[i % FRENZY_FLOOR_DEFS.length],
        x: randRange(300, WORLD_W - 300),
        y: randRange(300, WORLD_H - 300),
        w: FLOOR_SIZE,
        h: FLOOR_SIZE,
      });
    }
    this._broadcastMessage('🔥 残り1分30秒！ x3ブロック＆x4床が出現！');
  }

  _spawnBlock() {
    const r = Math.random();
    const tripleChance = this.frenzyActive ? TRIPLER_CHANCE : 0;
    let kind;
    if (r < MULTIPLIER_CHANCE) kind = { kind: 'multiplier', op: 'x2' };
    else if (r < MULTIPLIER_CHANCE + DIVIDER_CHANCE) kind = { kind: 'multiplier', op: 'div2' };
    else if (r < MULTIPLIER_CHANCE + DIVIDER_CHANCE + tripleChance) kind = { kind: 'multiplier', op: 'x3' };
    else kind = { kind: 'number', value: pickWeightedValue(this.frenzyActive) };

    this.blocks.push({
      id: this._nextId++,
      ...kind,
      x: randRange(60, WORLD_W - 60),
      y: randRange(60, WORLD_H - 60),
    });
  }

  update(dt) {
    if (!this.running) return;

    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.running = false;
      this.onEnd?.(this._standings());
      return;
    }
    this._maybeStartFrenzy();

    for (const s of this.snakes.values()) {
      if (!s.alive) {
        if (Date.now() >= s.respawnAt) s.spawn(s.respawnSum);
        continue;
      }
      this._steer(s);
      this._moveSnake(s, dt);
      this._resolveBlockObstacles(s);
    }

    this._resolvePickups();
    this._resolveCombat();
    this._resolveFloors();
  }

  _steer(s) {
    if (s.pointerActive) {
      s.desiredAngle = s.pointerAngle;
      return;
    }
    const { up, down, left, right } = s.keys;
    const vx = (right ? 1 : 0) - (left ? 1 : 0);
    const vy = (down ? 1 : 0) - (up ? 1 : 0);
    if (vx !== 0 || vy !== 0) s.desiredAngle = Math.atan2(vy, vx);
  }

  _moveSnake(s, dt) {
    let diff = s.desiredAngle - s.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const maxTurn = TURN_RATE * dt;
    s.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));

    const speed = Date.now() < s.boostUntil ? BASE_SPEED * BOOST_MULTIPLIER : BASE_SPEED;
    s.x += Math.cos(s.angle) * speed * dt;
    s.y += Math.sin(s.angle) * speed * dt;
    s.x = Math.max(10, Math.min(WORLD_W - 10, s.x));
    s.y = Math.max(10, Math.min(WORLD_H - 10, s.y));

    s.path.push({ x: s.x, y: s.y });
    const maxPathLen = chainSpan(s.chain) / (BASE_SPEED * dt) + 20;
    if (s.path.length > maxPathLen) s.path.splice(0, s.path.length - maxPathLen);
  }

  _resolveBlockObstacles(s) {
    const aHalf = blockHalfSize(s.headValue);
    for (const b of this.blocks) {
      if (b.kind === 'multiplier') continue;
      if (b.value <= s.headValue) continue;
      const o = squareOverlap(s.x, s.y, aHalf, b.x, b.y, blockHalfSize(b.value));
      if (!o) continue;
      if (o.ox < o.oy) s.x += Math.sign(o.dx || 1) * o.ox;
      else s.y += Math.sign(o.dy || 1) * o.oy;
      s.x = Math.max(10, Math.min(WORLD_W - 10, s.x));
      s.y = Math.max(10, Math.min(WORLD_H - 10, s.y));
    }
  }

  _checkTrophyExchange(s) {
    if (s.sum < 2048) return;
    const overflow = s.sum - 2048;
    s.sum = Math.max(1, Math.floor(overflow / 2));
    if (overflow === 0) {
      s.trophies += 2;
      this.onMessage?.(s.id, 'ピッタリ賞！トロフィー2倍！');
    } else {
      s.trophies++;
      this.onMessage?.(s.id, '2048をトロフィーと交換！');
    }
  }

  _applyGrowth(s, value) {
    s.sum += value;
    this._checkTrophyExchange(s);
  }

  _applyMultiplier(s, factor) {
    if (factor > 1) {
      s.sum *= factor;
      this._checkTrophyExchange(s);
    } else {
      s.sum = Math.max(1, Math.floor(s.sum * factor));
    }
  }

  _applyBoost(s, duration) {
    s.boostUntil = Math.max(s.boostUntil, Date.now() + duration);
  }

  _resolvePickups() {
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      const aHalf = blockHalfSize(s.headValue);
      for (let i = this.blocks.length - 1; i >= 0; i--) {
        const b = this.blocks[i];
        if (b.kind === 'multiplier') {
          if (squareOverlap(s.x, s.y, aHalf, b.x, b.y, MULTIPLIER_HALF, HIT_MARGIN)) {
            this.blocks.splice(i, 1);
            const factor = b.op === 'x2' ? 2 : b.op === 'x3' ? 3 : 0.5;
            this._applyMultiplier(s, factor);
            this._setTimeout(() => this._spawnBlock(), randRange(400, 1500));
          }
          continue;
        }
        if (b.value > s.headValue) continue;
        if (squareOverlap(s.x, s.y, aHalf, b.x, b.y, blockHalfSize(b.value), HIT_MARGIN)) {
          this.blocks.splice(i, 1);
          this._applyGrowth(s, b.value);
          this._setTimeout(() => this._spawnBlock(), randRange(400, 1500));
        }
      }
    }
  }

  _resolveFloors() {
    for (let i = this.floors.length - 1; i >= 0; i--) {
      const f = this.floors[i];
      for (const s of this.snakes.values()) {
        if (!s.alive) continue;
        const half = blockHalfSize(s.headValue);
        const overlapping =
          Math.abs(s.x - f.x) < f.w / 2 + half && Math.abs(s.y - f.y) < f.h / 2 + half;
        if (!overlapping) continue;
        if (f.type === 'double' && f.test(s.sum)) {
          this._applyMultiplier(s, 2);
          this._consumeFloor(i);
          break;
        }
        if (f.type === 'quad' && f.test(s.sum)) {
          this._applyMultiplier(s, 4);
          this._consumeFloor(i);
          break;
        }
        if (f.type === 'speed') {
          this._applyBoost(s, FLOOR_BOOST_DURATION);
          this._consumeFloor(i);
          break;
        }
      }
    }
  }

  _resolveCombat() {
    const alive = [...this.snakes.values()].filter((s) => s.alive);
    for (const a of alive) {
      for (const b of alive) {
        if (a === b || !a.alive || !b.alive) continue;
        if (b.isInvincible) continue;
        const aHalf = blockHalfSize(a.headValue);
        if (squareOverlap(a.x, a.y, aHalf, b.x, b.y, blockHalfSize(b.headValue), HIT_MARGIN)) {
          if (a.headValue > b.headValue) {
            this._applyGrowth(a, b.sum);
            this._kill(b);
          } else if (b.headValue > a.headValue) {
            this._applyGrowth(b, a.sum);
            this._kill(a);
          }
          continue;
        }
        const positions = b.segmentPositions();
        for (let i = 1; i < positions.length; i++) {
          const seg = positions[i];
          if (seg.value < a.headValue && squareOverlap(a.x, a.y, aHalf, seg.x, seg.y, blockHalfSize(seg.value), HIT_MARGIN)) {
            b.sum -= seg.value;
            this._applyGrowth(a, seg.value);
            break;
          }
        }
      }
    }
  }

  _kill(s) {
    s.alive = false;
    s.eatenCount++;
    s.respawnAt = Date.now() + RESPAWN_DELAY;
    s.respawnSum = Math.max(MIN_RESPAWN_VALUE, Math.floor(s.headValue / 2));
    this.onMessage?.(s.id, '食われた！');
  }

  _broadcastMessage(text) {
    for (const id of this.snakes.keys()) this.onMessage?.(id, text);
  }

  _standings() {
    return [...this.snakes.values()]
      .sort((a, b) => b.trophies - a.trophies || a.eatenCount - b.eatenCount)
      .map((s) => ({ id: s.id, name: s.name, trophies: s.trophies, eatenCount: s.eatenCount }));
  }

  standings() {
    return this._standings();
  }

  // Serializable snapshot sent to clients every tick.
  toState() {
    return {
      timeLeft: this.timeLeft,
      running: this.running,
      frenzyActive: this.frenzyActive,
      blocks: this.blocks,
      floors: this.floors.map((f) => ({
        id: f.id,
        type: f.type,
        label: f.label,
        color: f.color,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
      })),
      snakes: [...this.snakes.values()].map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        alive: s.alive,
        sum: s.sum,
        headValue: s.headValue,
        chain: s.chain,
        x: s.x,
        y: s.y,
        trophies: s.trophies,
        eatenCount: s.eatenCount,
        invincible: s.isInvincible,
        boostReadyAt: s.boostReadyAt,
        segments: s.alive ? s.segmentPositions() : [],
      })),
      standings: this._standings(),
    };
  }
}
