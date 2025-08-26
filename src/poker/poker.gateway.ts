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
      if (this.rooms[roomId]) {
        delete this.rooms[roomId][username];
        this.server.to(roomId).emit('roomUpdate', this.formatRoomUsers(roomId));
        this.server.to(roomId).emit('votesUpdate', this.formatVotes(roomId));
      }
      delete this.socketUserMap[client.id];
    }
    console.log(`Client disconnected: ${client.id}`);
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
    { roomId, username, role, admin }: { roomId: string; username: string; role: Role, admin: boolean },
  ) {
    for (const [socketId, info] of Object.entries(this.socketUserMap)) {
      if (info.username === username && info.roomId === roomId) {
        delete this.socketUserMap[socketId];
      }
    }
    client.join(roomId);
    if (!this.rooms[roomId]) {
      this.rooms[roomId] = {};
      this.roomRevealStates[roomId] = false;
    }
    this.rooms[roomId][username] = { vote: '', role, admin };
    this.socketUserMap[client.id] = { roomId, username, admin };
    
    this.server.to(roomId).emit('roomUpdate', this.formatRoomUsers(roomId));

    client.emit('votesUpdate', this.formatVotes(roomId));
    client.emit('roomState', {
      revealed: this.roomRevealStates[roomId] || false,
      votes: this.formatVotes(roomId),
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
}
