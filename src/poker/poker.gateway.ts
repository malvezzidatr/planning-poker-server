import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

interface VotePayload {
  roomId: string;
  username: string;
  card: string;
}

type Role = 'player' | 'spectator';

interface UserInfo {
  vote: string;
  role: Role;
  admin: boolean;
}

@WebSocketGateway({ cors: true })
export class PokerGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private rooms: Record<string, Record<string, UserInfo>> = {};
  private socketUserMap: Record<string, { roomId: string; username: string, admin: boolean }> = {};
  private roomRevealStates: Record<string, boolean> = {};
  private roomStories: Record<string, string[]> = {};

  private roomTimers: Record<string, {
    initialDuration: number;
    running: boolean;
    startedAt: number | null;
  }> = {};

  afterInit(server: Server) {
    console.log('WebSocket Initialized');
  }

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    const info = this.socketUserMap[client.id];
    if (info) {
      const { roomId, username } = info;
      console.log(`Client disconnected: room: ${roomId} username:${username} user_id:${client.id}`);

      if (this.rooms[roomId]) {
        delete this.rooms[roomId][username];
        this.server.to(roomId).emit('roomUpdate', this.formatRoomUsers(roomId));
        this.server.to(roomId).emit('votesUpdate', this.formatVotes(roomId));
      }
      delete this.socketUserMap[client.id];
    }
  }

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(client: Socket) {
    const info = this.socketUserMap[client.id];
    if (info) {
      const { roomId, username } = info;
      if (this.rooms[roomId]) {
        delete this.rooms[roomId][username];
        this.server.to(roomId).emit('roomUpdate', this.formatRoomUsers(roomId));
        this.server.to(roomId).emit('votesUpdate', this.formatVotes(roomId));
      }
      delete this.socketUserMap[client.id];
      client.leave(roomId);
    }
  }

  @SubscribeMessage('checkIfRoomExists')
  handleCheckIfRoomsExists(
    client: Socket,
    { roomId }: { roomId: string }
  ) {
    const exists = !!this.rooms[roomId]
    console.log(`Client is trying to connect to: ${roomId} ${!exists ? "this rooms doesn't exists" : ""}`);
    client.emit('checkIfRoomExistsResponse', { exists });
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(
    client: Socket,
    { roomId, username, role, admin, time, stories }: {
      roomId: string;
      username: string;
      role: Role,
      admin: boolean,
      time?: number,
      stories?: string[],
    },
  ) {
    console.log(`User ${username} has joined at room ${roomId}`);
    for (const [socketId, info] of Object.entries(this.socketUserMap)) {
      if (info.username === username && info.roomId === roomId) {
        delete this.socketUserMap[socketId];
      }
    }
    console.log('stories1', stories);
    client.join(roomId);
    if (!this.rooms[roomId]) {
      this.rooms[roomId] = {};
      this.roomRevealStates[roomId] = false;
    }
    this.rooms[roomId][username] = { vote: '', role, admin };
    this.socketUserMap[client.id] = { roomId, username, admin };
    client.emit('roomUpdate', this.formatRoomUsers(roomId));
    this.server.to(roomId).emit('roomUpdate', this.formatRoomUsers(roomId));
    client.emit('votesUpdate', this.formatVotes(roomId));
    client.emit('roomState', {
      revealed: this.roomRevealStates[roomId] || false,
      votes: this.formatVotes(roomId),
    });
    console.log('stories2', stories);
    
    if (!this.roomStories[roomId]) {
      this.roomStories[roomId] = stories && stories.length ? stories : [];
    }

    client.emit('userStoriesUpdate', this.roomStories[roomId]);
    
    if (!this.roomTimers[roomId]) {
      this.roomTimers[roomId] = { initialDuration: time ?? 0, running: false, startedAt: null };
    } else if (typeof time === 'number' && time > 0) {
      this.roomTimers[roomId].initialDuration = time;
    }

    const timer = this.roomTimers[roomId];
    client.emit('timerState', {
      duration: timer?.initialDuration ?? time,
      running: timer?.running ?? false,
      startedAt: timer?.startedAt ?? null,
      serverTime: Date.now(),
    });
  }

  @SubscribeMessage('vote')
  handleVote(client: Socket, payload: VotePayload) {
    const { roomId, username, card } = payload;
    if (!this.rooms[roomId]) return;

    if (this.rooms[roomId][username]) {
      this.rooms[roomId][username].vote = card;
    }

    this.server.to(roomId).emit('votesUpdate', this.formatVotes(roomId));
    this.server.to(roomId).emit('userVoted', username);
  }

  @SubscribeMessage('reset')
  handleReset(client: Socket, roomId: string) {
    if (!this.rooms[roomId]) return;

    for (const user in this.rooms[roomId]) {
      this.rooms[roomId][user].vote = '';
    }

    this.roomRevealStates[roomId] = false;
    this.server.to(roomId).emit('resetVotes');
  }

  @SubscribeMessage('reveal')
  handleReveal(client: Socket, roomId: string) {
    const roomVotes = this.rooms[roomId];
    if (roomVotes) {
      this.roomRevealStates[roomId] = true;

      const votos = Object.values(roomVotes)
        .filter((userInfo) => userInfo.role === 'player')
        .map((userInfo) => userInfo.vote);

      const media = this.calcularMedia(votos);
      const maisVotado = this.calcularMaisVotado(votos);

      this.server.to(roomId).emit('revealVotes', {
        votes: this.formatVotes(roomId),
        average: media,
        mostVoted: maisVotado,
      });
    }
  }

  @SubscribeMessage('changeUserRole')
  handleChangeUserRole(
    client: Socket,
    payload: { roomId: string, username: string }
  ) {
    const { roomId, username } = payload;
    
    const currentUserInfo = this.rooms[roomId][username];
    currentUserInfo.role = currentUserInfo.role === 'player' ? 'spectator' : 'player';
    currentUserInfo.vote = "";
    this.rooms[roomId][username] = currentUserInfo;
    this.server.to(roomId).emit('roomUpdate', this.formatRoomUsers(roomId));
    this.server.to(roomId).emit('votesUpdate', this.formatVotes(roomId));
  }

  @SubscribeMessage('changeUsername')
  handleChangeUsername(
    client: Socket,
    payload: { roomId: string; oldUsername: string; newUsername: string },
  ) {
    const { roomId, oldUsername, newUsername } = payload;

    if (
      !this.rooms[roomId] ||
      !(oldUsername in this.rooms[roomId]) ||
      !this.socketUserMap[client.id]
    ) {
      return;
    }

    const currentUserInfo = this.rooms[roomId][oldUsername];
    delete this.rooms[roomId][oldUsername];
    this.rooms[roomId][newUsername] = currentUserInfo;

    this.socketUserMap[client.id].username = newUsername;

    this.server.to(roomId).emit('roomUpdate', this.formatRoomUsers(roomId));
  }

  @SubscribeMessage('addUserStories')
  handleAddUserStories(client: Socket, payload: { roomId: string, userStories: string[] }) {
    const { roomId, userStories } = payload;
    console.log("stories4", userStories);
    this.roomStories[roomId] = userStories;
    this.server.to(roomId).emit('userStoriesUpdate', userStories);
  }

  @SubscribeMessage('startTimer')
  handleStartTimer(client: Socket, { roomId, duration }: { roomId: string, duration?: number }) {
    if (!this.roomTimers[roomId]) {
      this.roomTimers[roomId] = { initialDuration: duration ?? 0, running: false, startedAt: null };
    }
    const timer = this.roomTimers[roomId];
    if (typeof duration === 'number') timer.initialDuration = duration;

    timer.running = true;
    timer.startedAt = Date.now();
    this.emitTimerState(roomId);
  }

  @SubscribeMessage('pauseTimer')
  handlePauseTimer(client: Socket, { roomId }: { roomId: string }) {
    const timer = this.roomTimers[roomId];
    if (!timer) return;

    const elapsed = timer.startedAt ? Math.floor((Date.now() - timer.startedAt) / 1000) : 0;
    timer.initialDuration = Math.max(timer.initialDuration - elapsed, 0);
    timer.running = false;
    timer.startedAt = null;

    this.emitTimerState(roomId);
  }

  @SubscribeMessage('resetTimer')
handleResetTimer(client: Socket, { roomId, duration }: { roomId: string, duration?: number }) {
  if (!this.roomTimers[roomId]) {
    this.roomTimers[roomId] = { initialDuration: duration ?? 0, running: false, startedAt: null };
  } else {
    this.roomTimers[roomId].initialDuration = duration ?? this.roomTimers[roomId].initialDuration;
    this.roomTimers[roomId].running = false;
    this.roomTimers[roomId].startedAt = null;
  }
  this.emitTimerState(roomId);
}

  private formatRoomUsers(roomId: string) {
    if (!this.rooms[roomId]) return [];
    const users = Object.entries(this.rooms[roomId]).map(([username, info]) => ({
      username,
      role: info.role,
      admin: info.admin || false,
    }));
    return users;
  }

  private formatVotes(roomId: string) {
    if (!this.rooms[roomId]) return {};
    const votes: Record<string, string> = {};
    for (const [username, info] of Object.entries(this.rooms[roomId])) {
      votes[username] = info.vote;
    }
    return votes;
  }

  calcularMedia(votos: string[]): number {
    const valoresNumericos = votos.map((v) => Number(v)).filter((v) => !isNaN(v) && v !== 0);
    if (valoresNumericos.length === 0) return 0;
    const soma = valoresNumericos.reduce((acc, v) => acc + v, 0);
    return soma / valoresNumericos.length;
  }

  calcularMaisVotado(votos: string[]): string {
    const contagem: Record<string, number> = {};
    votos.forEach((v) => {
      if (v) contagem[v] = (contagem[v] || 0) + 1;
    });

    if (Object.keys(contagem).length === 0) return '';

    const maisVotado = Object.entries(contagem).reduce((a, b) => (b[1] > a[1] ? b : a));
    return maisVotado[0];
  }

  private emitTimerState(roomId: string) {
    const timer = this.roomTimers[roomId] || { initialDuration: 0, running: false, startedAt: null };
    this.server.to(roomId).emit('timerState', {
      duration: timer.initialDuration,
      running: timer.running,
      startedAt: timer.startedAt,
      serverTime: Date.now(),
    });
  }
}
