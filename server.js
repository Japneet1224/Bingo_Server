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
const friendsRooms = {}; 

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // ==========================================
  // 1. QUICK MATCH LOGIC
  // ==========================================
  socket.on('joinQuickMatch', () => {
    quickMatchQueue.push(socket);
    console.log(`Player joined Quick Match queue. Queue size: ${quickMatchQueue.length}`);

    if (quickMatchQueue.length >= 2) {
      const player1 = quickMatchQueue.shift();
      const player2 = quickMatchQueue.shift();

      const roomName = `qm_${player1.id}_${player2.id}`;
      
      player1.join(roomName);
      player2.join(roomName);
      player1.qmRoom = roomName;
      player2.qmRoom = roomName;

      io.to(roomName).emit('matchFound', { startingPlayer: player1.id });
      console.log(`Quick Match started: Room ${roomName}`);
    }
  });

  // --- NEW REMATCH LOGIC ---
  socket.on('requestRematch', () => {
    if (socket.qmRoom) socket.to(socket.qmRoom).emit('rematchRequested');
  });

  socket.on('acceptRematch', () => {
    if (socket.qmRoom) {
      // Both players are ready. Restart the match in the exact same room!
      // We will make the person who accepted go first.
      io.to(socket.qmRoom).emit('matchFound', { startingPlayer: socket.id });
    }
  });

  socket.on('declineRematch', () => {
    if (socket.qmRoom) socket.to(socket.qmRoom).emit('rematchDeclined');
  });

  socket.on('leaveMatch', () => {
    if (socket.qmRoom) {
      socket.to(socket.qmRoom).emit('opponentLeft');
      socket.leave(socket.qmRoom);
      socket.qmRoom = null;
    }
  });

  // 2. FRIENDS MODE LOGIC
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
  });

  socket.on('joinRoom', (data) => {
    const { playerName, roomCode } = data;
    const room = friendsRooms[roomCode];
    
    if (room) {
      if (room.status === 'lobby' && room.players.length < 5) {
        room.players.push({ id: socket.id, name: playerName, lines: 0 });
        socket.join(roomCode);
        socket.friendsRoom = roomCode;
        io.to(roomCode).emit('roomUpdated', room.players);
      } 
      else if (room.status === 'playing') {
        const existingPlayer = room.players.find(p => p.name === playerName);
        if (existingPlayer) {
          existingPlayer.id = socket.id; 
          socket.join(roomCode);
          socket.friendsRoom = roomCode;
        }
      }
    }
  });

  socket.on('startGame', (roomCode) => {
    const room = friendsRooms[roomCode];
    if (room) {
      room.status = 'playing';
      
      // THE FIX: Wipe the leaderboard memory on the server before starting!
      room.players.forEach(p => p.lines = 0);
      io.to(roomCode).emit('roomUpdated', room.players);

      io.to(roomCode).emit('gameStarted', room.players[0].name);
    }
  });

  // 3. SHARED GAMEPLAY LOGIC
  socket.on('shareBoard', (board) => {
    if (socket.qmRoom) {
      socket.to(socket.qmRoom).emit('opponentBoard', board);
    }
  });

  socket.on('shareFriendsBoard', (data) => {
    const { roomCode, board, playerId } = data;
    socket.to(roomCode).emit('friendsBoardShared', { playerId, board });
  });

  socket.on('selectNumber', (data) => {
    if (typeof data === 'number') {
      if (socket.qmRoom) socket.to(socket.qmRoom).emit('numberSelected', data);
    } 
    else {
      const { roomCode, number } = data;
      const room = friendsRooms[roomCode];
      if (room) {
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        const nextTurnName = room.players[room.currentTurnIndex].name;
        io.to(roomCode).emit('numberSelected', { number, nextTurnName });
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

  // 4. DISCONNECT HANDLING
  socket.on('disconnect', () => {
    quickMatchQueue = quickMatchQueue.filter(s => s.id !== socket.id);

    if (socket.qmRoom) {
      socket.to(socket.qmRoom).emit('opponentDisconnected');
    }

    if (socket.friendsRoom) {
      const room = friendsRooms[socket.friendsRoom];
      if (room && room.status === 'lobby') {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
          delete friendsRooms[socket.friendsRoom]; 
        } else {
          io.to(socket.friendsRoom).emit('roomUpdated', room.players);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Multiplayer Server running on port ${PORT}`);
});