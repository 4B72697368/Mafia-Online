import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import crypto from 'crypto';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const rooms: Record<string, {
  messages: Array<{ user: string, message: string, timestamp: number }>;
  users: Record<string, {
    id: string,
    username: string,
    status: 'alive' | 'dead',
    role?: 'mafia' | 'townspeople' | 'doctor' | 'detective'
  }>;
  host?: string;
  state: 'pre-game' | 'in-progress' | 'completed';
  startTime?: number;
}> = {};

function generateRoomCode(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function formatTime(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

interface User {
  id: string;
  username: string;
  status: 'alive' | 'dead';
  role?: 'mafia' | 'townspeople' | 'doctor' | 'detective';
}

interface Message {
  user: string;
  message: string;
  timestamp: number;
}

interface Room {
  messages: Message[];
  users: Record<string, User>;
  host?: string;
  state: 'pre-game' | 'in-progress' | 'completed';
  startTime?: number;
}

function assignRoles(room: Room): boolean {
  const players = Object.values(room.users);
  if (players.length < 5) {
    return false;
  }

  const shuffled: User[] = [...players].sort(() => 0.5 - Math.random());

  shuffled[0].role = 'mafia';
  shuffled[1].role = 'doctor';
  shuffled[2].role = 'detective';

  shuffled.slice(3).forEach(player => {
    player.role = 'townspeople';
  });

  return true;
}

async function gameLoop(room: Room, roomCode: string) {
  while (room.state !== 'completed') {
    const alivePlayers = Object.values(room.users)
      .filter(user => user.status === 'alive')
      .map(user => user.username);

    io.to(roomCode).emit('new-message', {
      user: 'System',
      message: 'Night Cycle Started',
      timestamp: Date.now()
    });

    let killAction: { action: 'kill', player: string } | null = null;
    let healAction: { action: 'heal', player: string } | null = null;
    let guessAction: { action: 'guess', player: string } | null = null;

    const actionPromise = new Promise<void>((resolve) => {
      const actionListener = (data: { action: string, player: string }) => {
        switch (data.action) {
          case 'kill':
            killAction = { action: 'kill', player: data.player };
            break;
          case 'heal':
            healAction = { action: 'heal', player: data.player };
            break;
          case 'guess':
            guessAction = { action: 'guess', player: data.player };
            break;
        }
      };

      io.on('event', actionListener);

      setTimeout(() => {
        io.off('event', actionListener);
        resolve();
      }, 30000);
    });

    await actionPromise;

    const aliveMafia = Object.values(room.users)
      .filter(user => user.role === 'mafia' && user.status === 'alive');
    const aliveDetectives = Object.values(room.users)
      .filter(user => user.role === 'detective' && user.status === 'alive');
    const aliveDoctors = Object.values(room.users)
      .filter(user => user.role === 'doctor' && user.status === 'alive');

    if (!killAction && aliveMafia.length > 0) {
      const randomKillTargets = alivePlayers.filter(p =>
        p !== aliveMafia[0].username
      );
      const randomKillTarget = randomKillTargets[Math.floor(Math.random() * randomKillTargets.length)];
      killAction = { action: 'kill', player: randomKillTarget };
    }

    const resolvedActions: any[] = [];

    if (killAction) {
      resolvedActions.push(killAction);
      const killedPlayer = Object.values(room.users)
        .find(user => user.username === killAction?.player);

      const healedByDoctor = healAction && healAction.player === killAction.player;

      if (killedPlayer && !healedByDoctor) {
        killedPlayer.status = 'dead';
      }
    }

    if (healAction) resolvedActions.push(healAction);
    if (guessAction) {
      resolvedActions.push(guessAction);

      const guessedPlayer = Object.values(room.users)
        .find(user => user.username === guessAction?.player);
      console.log(guessedPlayer)
      if (guessedPlayer?.role === 'mafia') {
        room.state = 'completed';
        io.to(roomCode).emit('game-over', { winner: 'detectives' });
        return;
      }
    }

    io.to(roomCode).emit('night-cycle-resolution', {
      actions: resolvedActions
    });

    await new Promise(resolve => setTimeout(resolve, 20000));

    const remainingMafia = Object.values(room.users)
      .filter(user => user.role === 'mafia' && user.status === 'alive');
    const remainingTownspeople = Object.values(room.users)
      .filter(user => user.role === 'townspeople' && user.status === 'alive');
    const remainingDetectives = Object.values(room.users)
      .filter(user => user.role === 'detective' && user.status === 'alive');
    const remainingDoctors = Object.values(room.users)
      .filter(user => user.role === 'doctor' && user.status === 'alive');

    if (remainingMafia.length === 0) {
      room.state = 'completed';
      io.to(roomCode).emit('game-over', { winner: 'townspeople' });
      return;
    }

    if (remainingTownspeople.length + remainingDetectives.length + remainingDoctors.length <= 1) {
      room.state = 'completed';
      io.to(roomCode).emit('game-over', { winner: 'mafia' });
      return;
    }
  }
}

io.on('connection', (socket: Socket) => {
  socket.on('create-room', () => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      messages: [],
      users: {},
      host: socket.id,
      state: 'pre-game'
    };
    socket.emit('room-created', roomCode);
  });

  socket.on('join-room', ({ roomCode, username }) => {
    const room = rooms[roomCode];
    if (room) {
      if (Object.values(room.users).some(user => user.username === username)) {
        socket.emit('room-error', {
          type: 'username-taken',
          message: 'Username is already in use'
        });
        return;
      }

      if (room.state === 'in-progress') {
        socket.emit('room-error', {
          type: 'game-in-progress',
          message: 'Game is already in session'
        });
        return;
      }

      room.users[socket.id] = {
        id: socket.id,
        username,
        status: 'alive'
      };
      socket.join(roomCode);

      if (room.host) {
        io.to(room.host).emit('player-joined', username);
      }

      socket.emit('room-joined', {
        roomCode,
        messages: room.messages,
        users: Object.values(room.users).map(user => ({
          username: user.username,
          status: user.status
        })),
        state: room.state,
        startTime: room.startTime
      });
    } else {
      socket.emit('room-error', {
        type: 'not-found',
        message: 'Room does not exist'
      });
    }
  });

  socket.on('send-message', ({ roomCode, message, user }) => {
    const room = rooms[roomCode];
    if (room && room.state === 'in-progress') {
      const newMessage = {
        user,
        message,
        timestamp: Date.now()
      };
      room.messages.push(newMessage);

      io.to(roomCode).emit('new-message', newMessage);
    }
  });

  socket.on('start-game', async (roomCode: string) => {
    const room = rooms[roomCode];
    if (room && room.host === socket.id) {
      assignRoles(room);

      room.state = 'in-progress';
      room.startTime = Date.now();

      Object.entries(room.users).forEach(([socketId, user]) => {
        io.to(socketId).emit('your-role', user.role);
      });

      const timerInterval = setInterval(() => {
        if (room.state === 'in-progress') {
          io.to(roomCode).emit('game-timer', formatTime(room.startTime));
        } else {
          clearInterval(timerInterval);
        }
      }, 1000);

      io.to(roomCode).emit('game-started', {
        startTime: room.startTime,
        players: Object.values(room.users).map(user => ({
          username: user.username,
          status: user.status
        }))
      });

      await gameLoop(room, roomCode);
    }
  });

  socket.on('disconnect', () => {
    for (const [roomCode, room] of Object.entries(rooms)) {
      if (room.users[socket.id]) {
        const username = room.users[socket.id].username;
        delete room.users[socket.id];

        if (room.host === socket.id) {
          io.to(roomCode).emit('host-disconnected');
          delete rooms[roomCode];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export { app, httpServer, io };