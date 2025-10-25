// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const { Chess } = require('chess.js');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// serve static single-folder (index.html etc)
app.use(express.static(path.join(__dirname)));

const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);

// persistent JSON files (append-in-memory snapshots)
const GAMES_FILE = path.join(DATA_DIR, 'games.json'); // array of finished games
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json'); // join/leave events
const SERVERSTATUS_FILE = path.join(DATA_DIR, 'serverStatus.json'); // server empty/full log

// initialize files if missing
for (const f of [GAMES_FILE, ACTIVITY_FILE, SERVERSTATUS_FILE]) {
  if (!fs.existsSync(f)) fs.writeJsonSync(f, []);
}

// In-memory data (RAM-first)
const rooms = {}; // roomId -> { game:Chess(), players: [{id,name,side}], moves:[], createdAt, startedAt, lastActivity, summary }
let onlineCount = 0;

// Helper: write activity event
function logActivity(eventObj) {
  const arr = fs.readJsonSync(ACTIVITY_FILE);
  arr.push(eventObj);
  fs.writeJsonSync(ACTIVITY_FILE, arr, { spaces: 2 });
}

// Helper: append finished game
function appendFinishedGame(gameRecord) {
  const arr = fs.readJsonSync(GAMES_FILE);
  arr.push(gameRecord);
  fs.writeJsonSync(GAMES_FILE, arr, { spaces: 2 });
}

// Helper: log server status (empty / non-empty)
function logServerStatus(status) {
  const arr = fs.readJsonSync(SERVERSTATUS_FILE);
  arr.push({ time: new Date().toISOString(), status });
  fs.writeJsonSync(SERVERSTATUS_FILE, arr, { spaces: 2 });
}

// update online count and log server empty event if 0
function setOnlineCount(n) {
  onlineCount = n;
  if (onlineCount === 0) {
    logServerStatus('empty');
  } else {
    logServerStatus('non-empty');
  }
}

// Clean up idle rooms periodically (optional)
setInterval(() => {
  const now = Date.now();
  for (const rId of Object.keys(rooms)) {
    const r = rooms[rId];
    // 2 hours idle auto-delete
    if (now - (r.lastActivity || now) > 1000 * 60 * 60 * 2) {
      console.log('Auto-deleting idle room', rId);
      delete rooms[rId];
    }
  }
}, 1000 * 60 * 5);

// Socket.IO logic
io.on('connection', (socket) => {
  console.log('connect', socket.id);
  setOnlineCount(Object.keys(io.sockets.sockets).length);

  // client: createRoom { name }
  socket.on('createRoom', ({ name }, cb) => {
    const roomId = uuidv4().slice(0, 8);
    const game = new Chess();
    rooms[roomId] = {
      game,
      players: [{ id: socket.id, name: name || 'anon', side: 'white' }],
      moves: [],
      createdAt: new Date().toISOString(),
      startedAt: null,
      lastActivity: Date.now(),
      summary: null
    };
    socket.join(roomId);
    logActivity({ event: 'create', roomId, playerId: socket.id, name: name || 'anon', time: new Date().toISOString(), currentPlayers: rooms[roomId].players.length });
    cb && cb({ ok: true, roomId });
    io.to(roomId).emit('roomUpdate', { players: rooms[roomId].players.map(p => ({ id: p.id, name: p.name, side: p.side })) });
  });

  // client: joinRoom { roomId, name }
  socket.on('joinRoom', ({ roomId, name }, cb) => {
    const r = rooms[roomId];
    if (!r) {
      return cb && cb({ ok: false, msg: 'room-not-found' });
    }
    if (r.players.length >= 2) {
      return cb && cb({ ok: false, msg: 'room-full' });
    }

    const side = r.players.some(p => p.side === 'white') ? 'black' : 'white';
    r.players.push({ id: socket.id, name: name || 'anon', side });
    r.lastActivity = Date.now();
    socket.join(roomId);

    logActivity({ event: 'join', roomId, playerId: socket.id, name: name || 'anon', time: new Date().toISOString(), currentPlayers: r.players.length });

    // start game if 2 players present
    if (r.players.length === 2) {
      r.startedAt = new Date().toISOString();
      io.to(roomId).emit('startGame', { roomId, players: r.players.map(p => ({ id: p.id, name: p.name, side: p.side })), fen: r.game.fen() });
    } else {
      io.to(roomId).emit('roomUpdate', { players: r.players.map(p => ({ id: p.id, name: p.name, side: p.side })) });
    }

    cb && cb({ ok: true, roomId });
  });

  // client: move -> { roomId, from, to, promotion, clientTimestamp, clientThinkMs }
  socket.on('move', (payload) => {
    const { roomId, from, to, promotion, clientTimestamp, clientThinkMs } = payload;
    const r = rooms[roomId];
    if (!r) return socket.emit('error', { msg: 'no-room' });

    // validate move on server
    const move = r.game.move({ from, to, promotion: promotion || 'q' });
    if (!move) {
      // invalid move
      r.lastActivity = Date.now();
      r.moves.push({ seq: r.moves.length + 1, type: 'invalid', playerId: socket.id, from, to, timestamp: new Date().toISOString() });
      socket.emit('invalidMove', { reason: 'illegal' });
      return;
    }

    // accepted
    r.lastActivity = Date.now();
    const now = new Date().toISOString();
    const moveObj = {
      seq: r.moves.length + 1,
      playerId: socket.id,
      from,
      to,
      san: move.san,
      fen: r.game.fen(),
      serverTimestamp: now,
      clientTimestamp: clientTimestamp || null,
      thinkTimeMs: clientThinkMs || null
    };
    r.moves.push(moveObj);

    // broadcast to room
    io.to(roomId).emit('moveAccepted', moveObj);

    // check events
    if (r.game.in_checkmate()) {
      r.summary = {
        winner: socket.id,
        totalMoves: r.moves.length,
        durationMs: Date.now() - Date.parse(r.startedAt || r.createdAt),
        finalFEN: r.game.fen(),
        pgn: r.game.pgn ? r.game.pgn() : null
      };
      r.events = r.events || [];
      r.events.push({ type: 'checkmate', winner: socket.id, time: now });
      io.to(roomId).emit('gameOver', r.summary);

      // persist finished game to data/games.json
      const finished = {
        roomId,
        meta: { createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: now },
        players: r.players,
        moves: r.moves,
        summary: r.summary
      };
      appendFinishedGame(finished);

      // optionally remove room to free RAM (we will keep it but mark finished)
      // delete rooms[roomId];
    } else if (r.game.in_check()) {
      io.to(roomId).emit('inCheck', { playerId: socket.id, time: now });
    }
  });

  // client may call to end/resign
  socket.on('resign', ({ roomId }) => {
    const r = rooms[roomId];
    if (!r) return;
    const now = new Date().toISOString();
    const winner = r.players.find(p => p.id !== socket.id);
    r.summary = { winner: winner ? winner.id : null, reason: 'resign', finishedAt: now, totalMoves: r.moves.length, pgn: r.game.pgn ? r.game.pgn() : null };
    io.to(roomId).emit('gameOver', r.summary);
    appendFinishedGame({ roomId, meta: { createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: now }, players: r.players, moves: r.moves, summary: r.summary });
  });

  // leaving room / disconnect
  socket.on('leaveRoom', ({ roomId }) => {
    const r = rooms[roomId];
    if (!r) return;
    r.players = r.players.filter(p => p.id !== socket.id);
    socket.leave(roomId);
    r.lastActivity = Date.now();
    logActivity({ event: 'leave', roomId, playerId: socket.id, time: new Date().toISOString(), currentPlayers: r.players.length });
    io.to(roomId).emit('roomUpdate', { players: r.players.map(p => ({ id: p.id, name: p.name })) });
    if (r.players.length === 0) {
      // mark server empty for that room
      delete rooms[roomId];
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    setTimeout(() => { // tiny delay to let leaveRoom fire if explicitly called
      // remove from any rooms
      for (const roomId of Object.keys(rooms)) {
        const r = rooms[roomId];
        const idx = r.players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
          r.players.splice(idx, 1);
          logActivity({ event: 'disconnect', roomId, playerId: socket.id, time: new Date().toISOString(), currentPlayers: r.players.length });
          io.to(roomId).emit('roomUpdate', { players: r.players.map(p => ({ id: p.id, name: p.name })) });
          if (r.players.length === 0) {
            // persist empty-room status? just delete
            delete rooms[roomId];
          }
        }
      }
      setOnlineCount(Object.keys(io.sockets.sockets).length);
    }, 100);
  });

});

// simple API endpoints to get data (you can call these to download)
app.get('/api/rooms', (req, res) => {
  const list = Object.keys(rooms).map(id => ({ roomId: id, players: rooms[id].players.length, createdAt: rooms[id].createdAt }));
  res.json(list);
});

app.get('/api/export/game/:roomId', (req, res) => {
  const r = rooms[req.params.roomId];
  if (!r) return res.status(404).send('room not found');
  res.json({ roomId: req.params.roomId, meta: { createdAt: r.createdAt, startedAt: r.startedAt }, players: r.players, moves: r.moves, summary: r.summary });
});

app.get('/api/export/all-finished', (req, res) => {
  const arr = fs.readJsonSync(GAMES_FILE);
  res.json(arr);
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  // initial status
  setOnlineCount(Object.keys(io.sockets.sockets).length);
});
