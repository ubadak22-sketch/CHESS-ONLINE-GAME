// script.js — frontend logic
const socket = io();
const nameEl = document.getElementById('name');
const roomEl = document.getElementById('room');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const statusEl = document.getElementById('status');
const pgnEl = document.getElementById('pgn');

let board = null;
let game = new Chess();
let mySide = 'white';
let currentRoom = null;
let lastOpponentMoveTime = Date.now();
let lastMoveTimestamp = Date.now();
let connected = false;

// chessboard config
const cfg = {
  draggable: true,
  position: 'start',
  onDragStart: onDragStart,
  onDrop: onDrop,
  onSnapEnd: onSnapEnd
};

board = Chessboard('board', cfg);

// UI helpers
function setStatus(t) { statusEl.textContent = t; }
function setMovesText() { pgnEl.textContent = game.pgn ? game.pgn() : '-'; }

// socket events
socket.on('connect', () => { connected = true; setStatus('Connected to server'); });
socket.on('disconnect', () => { connected = false; setStatus('Disconnected'); });

// created
createBtn.onclick = () => {
  const name = nameEl.value || 'anon';
  socket.emit('createRoom', { name }, (resp) => {
    if (resp && resp.ok) {
      currentRoom = resp.roomId;
      setStatus(`Room created: ${currentRoom} (waiting for opponent)`);
      roomEl.value = currentRoom;
      leaveBtn.style.display = '';
    } else {
      setStatus('Create failed');
    }
  });
};

// join
joinBtn.onclick = () => {
  const r = roomEl.value;
  const name = nameEl.value || 'anon';
  if (!r) return alert('enter room id or create one');
  socket.emit('joinRoom', { roomId: r, name }, (resp) => {
    if (resp && resp.ok) {
      currentRoom = r;
      setStatus(`Joined room ${currentRoom}. Waiting or game started.`);
      leaveBtn.style.display = '';
    } else {
      setStatus('Join failed: ' + (resp.msg || ''));
    }
  });
};

// leave
leaveBtn.onclick = () => {
  if (!currentRoom) return;
  socket.emit('leaveRoom', { roomId: currentRoom });
  setStatus('Left room');
  currentRoom = null;
  leaveBtn.style.display = 'none';
};

// startGame when two players ready
socket.on('startGame', (data) => {
  // data: { roomId, players, fen }
  setStatus('Game started!');
  game = new Chess();
  board.position(data.fen || 'start');
  setMovesText();

  // determine side based on your socket id
  const me = data.players.find(p => p.id === socket.id);
  if (me) mySide = me.side;
  board.orientation(mySide);
});

// moveAccepted from server (other player's move or your move echoed)
socket.on('moveAccepted', (moveObj) => {
  // moveObj includes fen, san, seq, playerId, timestamps
  game.load(moveObj.fen);
  board.position(moveObj.fen);
  setMovesText();
  lastOpponentMoveTime = Date.now();
});

// invalidMove
socket.on('invalidMove', (info) => {
  setStatus('Invalid move: ' + (info.reason || 'illegal'));
  board.position(game.fen());
});

// inCheck
socket.on('inCheck', () => {
  setStatus('Check!');
});

// gameOver
socket.on('gameOver', (summary) => {
  setStatus('Game Over: ' + (summary.winner ? ('winner ' + summary.winner) : 'draw'));
  // optionally fetch final pgn from server or display summary
});

// roomUpdate (players joined/left)
socket.on('roomUpdate', (data) => {
  setStatus('Room players: ' + (data.players ? data.players.map(p => p.name).join(', ') : ''));
});

// helper: prevent picking up opponent piece or if game over
function onDragStart(source, piece, position, orientation) {
  if (game.game_over()) return false;
  if ((game.turn() === 'w' && piece.search(/^b/) !== -1) ||
      (game.turn() === 'b' && piece.search(/^w/) !== -1)) {
    return false;
  }
  // prevent moving opponent piece based on side
  if ((mySide === 'white' && piece.search(/^b/) !== -1) || (mySide === 'black' && piece.search(/^w/) !== -1)) {
    return false;
  }
}

function onDrop(source, target) {
  // try move locally (client preview)
  const move = game.move({ from: source, to: target, promotion: 'q' });
  if (move === null) return 'snapback';

  // send to server with telemetry
  const payload = {
    roomId: currentRoom,
    from: source,
    to: target,
    promotion: move.promotion || 'q',
    clientTimestamp: Date.now(),
    clientThinkMs: Date.now() - lastMoveTimestamp
  };
  lastMoveTimestamp = Date.now();
  socket.emit('move', payload);
  // we wait for server moveAccepted to update board to ensure server-authoritative state
}

function onSnapEnd() {
  // noop: will be updated when server sends moveAccepted
  board.position(game.fen());
}
