const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Create HTTP server and attach Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allows your React Native app to connect
    methods: ["GET", "POST"]
  }
});

// --- GAME STATE MEMORY ---
let quickMatchQueue = [];
const friendsRooms = {}; // Format: { [roomCode]: { players: [{id, name, lines}], turnIndex: 0, status: 'lobby' } }

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // ==========================================
  // 1. QUICK MATCH LOGIC
  // ==========================================
  socket.on('joinQuickMatch', () => {
    quickMatchQueue.push(socket);
    console.log(`Player joined Quick Match queue. Queue size: ${quickMatchQueue.length}`);

    // If 2 players are in queue, match them up!
    if (quickMatchQueue.length >= 2) {
      const player1 = quickMatchQueue.shift();
      const player2 = quickMatchQueue.shift();

      const roomName = `qm_${player1.id}_${player2.id}`;
      
      player1.join(roomName);
      player2.join(roomName);

      // Save room info to socket for easy access
      player1.qmRoom = roomName;
      player2.qmRoom = roomName;

      // Tell both players the match started, and player 1 goes first
      io.to(roomName).emit('matchFound', { startingPlayer: player1.id });
      console.log(`Quick Match started: Room ${roomName}`);
    }
  });

  // ==========================================
  // 2. FRIENDS MODE LOGIC
  // ==========================================
  socket.on('createRoom', (data) => {
    const { playerName, roomCode } = data;
    friendsRooms[roomCode] = {
      players: [{ id: socket.id, name: playerName, lines: 0 }],
      currentTurnIndex: 0,
      status: 'lobby'
    };
    socket.join(roomCode);
    socket.friendsRoom = roomCode;
    io.to(roomCode).emit('roomUpdated', friendsRooms[roomCode].players);
    console.log(`Room created: ${roomCode} by ${playerName}`);
  });

  socket.on('joinRoom', (data) => {
    const { playerName, roomCode } = data;
    const room = friendsRooms[roomCode];
    
    if (room && room.status === 'lobby' && room.players.length < 5) {
      room.players.push({ id: socket.id, name: playerName, lines: 0 });
      socket.join(roomCode);
      socket.friendsRoom = roomCode;
      io.to(roomCode).emit('roomUpdated', room.players);
      console.log(`${playerName} joined room: ${roomCode}`);
    }
  });

  socket.on('shareFriendsBoard', (data) => {
    const {roomCode, board, playerId} = data;
    socket.io(roomCode).emit('friendsBoardShared', {playerId, board});
  });

  socket.on('startGame', (roomCode) => {
    const room = friendsRooms[roomCode];
    if (room) {
      room.status = 'playing';
      // Host (player index 0) goes first
      io.to(roomCode).emit('gameStarted', room.players[0].id);
    }
  });

  // ==========================================
  // 3. SHARED GAMEPLAY LOGIC (Numbers & Bingo)
  // ==========================================
  
  // Silently exchange boards at the start of a match for the Game Over reveal
  socket.on('shareBoard', (board) => {
    if (socket.qmRoom) {
      socket.to(socket.qmRoom).emit('opponentBoard', board);
    }
  });

  socket.on('selectNumber', (data) => {
    // Check if it's Quick Match (payload is a simple number)
    if (typeof data === 'number') {
      if (socket.qmRoom) socket.to(socket.qmRoom).emit('numberSelected', data);
    } 
    // Otherwise it's Friends mode (payload is an object: { roomCode, number })
    else {
      const { roomCode, number } = data;
      const room = friendsRooms[roomCode];
      if (room) {
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        const nextTurnId = room.players[room.currentTurnIndex].id;
        io.to(roomCode).emit('numberSelected', { number, nextTurnId });
      }
    }
  });

  socket.on('updateLines', (data) => {
    if (typeof data === 'number') {
      if (socket.qmRoom) socket.to(socket.qmRoom).emit('opponentLines', data);
    } else {
      const { roomCode, lines } = data;
      const room = friendsRooms[roomCode];
      if (room) {
        const player = room.players.find(p => p.id === socket.id);
        if (player) player.lines = lines;
        io.to(roomCode).emit('playerLinesUpdated', { id: socket.id, lines });
      }
    }
  });

  socket.on('bingo', (data) => {
    if (socket.qmRoom) {
      socket.emit('gameOver', 'me');
      socket.to(socket.qmRoom).emit('gameOver', 'opponent');
    } else if (data) {
      const { roomCode, playerName } = data;
      io.to(roomCode).emit('gameOver', playerName);
    }
  });

  // ==========================================
  // 4. DISCONNECT HANDLING
  // ==========================================
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);

    // Remove from Quick Match queue if they were waiting
    quickMatchQueue = quickMatchQueue.filter(s => s.id !== socket.id);

    // Auto-win for opponent if in an active Quick Match
    if (socket.qmRoom) {
      socket.to(socket.qmRoom).emit('opponentDisconnected');
    }

    // Handle leaving a Friends Lobby
    if (socket.friendsRoom) {
      const room = friendsRooms[socket.friendsRoom];
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
          delete friendsRooms[socket.friendsRoom]; // Delete empty room
        } else {
          io.to(socket.friendsRoom).emit('roomUpdated', room.players);
        }
      }
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`AION Innovations Multiplayer Server running on port ${PORT}`);
});