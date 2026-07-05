import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { Room, MAX_PLAYERS } from './game/room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TICK_HZ = 20;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'client', 'dist')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

/** @type {Map<string, Room>} */
const rooms = new Map();
// Which room code each socket currently belongs to.
const socketRoom = new Map();

function makeRoomCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));
  return code;
}

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = new Room(code, {
      onMessage: (snakeId, text) => io.to(roomSocketId(code, snakeId)).emit('toast', text),
      onEnd: (standings) => io.to(code).emit('gameOver', standings),
      onCancel: () => {
        io.to(code).emit('cancelled');
        io.to(code).emit('lobby', lobbyState(room));
      },
    });
    rooms.set(code, room);
  }
  return room;
}

// Snake ids are just socket ids, so this is an identity helper kept for clarity.
function roomSocketId(_code, snakeId) {
  return snakeId;
}

function lobbyState(room) {
  return {
    code: room.code,
    running: room.running,
    hostId: room.hostId,
    aiCount: room.aiCount,
    players: room.humanIds.map((id) => ({ id, name: room.snakes.get(id).name })),
    maxPlayers: MAX_PLAYERS,
  };
}

function destroyRoomIfEmpty(code) {
  const room = rooms.get(code);
  if (room && room.humanCount === 0) {
    room.destroy();
    rooms.delete(code);
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', (name, ack) => {
    const code = makeRoomCode();
    const room = getOrCreateRoom(code);
    joinRoom(socket, room, name);
    ack?.({ ok: true, code });
  });

  socket.on('joinRoom', (code, name, ack) => {
    code = String(code || '').trim();
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: '部屋が見つかりません' });
    if (room.humanCount + room.aiCount >= MAX_PLAYERS) {
      return ack?.({ ok: false, error: '満員です（AI枠を含めて最大6人）' });
    }
    joinRoom(socket, room, name);
    ack?.({ ok: true, code });
  });

  function joinRoom(socket, room, name) {
    socket.join(room.code);
    socketRoom.set(socket.id, room.code);
    room.addPlayer(socket.id, (name || 'プレイヤー').slice(0, 12));
    io.to(room.code).emit('lobby', lobbyState(room));
  }

  socket.on('startGame', () => {
    const code = socketRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.running) return;
    room.start();
    io.to(code).emit('started');
  });

  socket.on('setAiCount', (count) => {
    const room = rooms.get(socketRoom.get(socket.id));
    if (!room) return;
    room.setAiCount(socket.id, count);
    io.to(room.code).emit('lobby', lobbyState(room));
  });

  socket.on('cancelRoom', () => {
    const room = rooms.get(socketRoom.get(socket.id));
    room?.cancel(socket.id);
  });

  socket.on('input', (keys) => {
    const room = rooms.get(socketRoom.get(socket.id));
    room?.setInput(socket.id, keys);
  });

  socket.on('pointer', (angle) => {
    const room = rooms.get(socketRoom.get(socket.id));
    room?.setPointerAngle(socket.id, angle);
  });

  socket.on('clearPointer', () => {
    const room = rooms.get(socketRoom.get(socket.id));
    room?.clearPointer(socket.id);
  });

  socket.on('boost', () => {
    const room = rooms.get(socketRoom.get(socket.id));
    room?.triggerBoost(socket.id);
  });

  socket.on('leaveRoom', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => leaveCurrentRoom(socket));

  function leaveCurrentRoom(socket) {
    const code = socketRoom.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (room) {
      room.removePlayer(socket.id);
      io.to(code).emit('lobby', lobbyState(room));
      destroyRoomIfEmpty(code);
    }
    socketRoom.delete(socket.id);
    socket.leave(code);
  }
});

// Single authoritative tick loop driving every active room.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  for (const [code, room] of rooms) {
    if (!room.running) continue;
    room.update(dt);
    io.to(code).emit('state', room.toState());
  }
}, 1000 / TICK_HZ);

httpServer.listen(PORT, () => {
  console.log(`Square 2048 multiplayer server listening on :${PORT}`);
});
