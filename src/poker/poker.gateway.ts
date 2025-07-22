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

@WebSocketGateway({ cors: true })
export class PokerGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private rooms: Record<string, Record<string, string>> = {};
  private socketUserMap: Record<string, { roomId: string, username: string }> = {};
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
        this.server.to(roomId).emit('roomUpdate', Object.keys(this.rooms[roomId]));

        // 🔥 NOVO: emite votos atualizados
        this.server.to(roomId).emit('votesUpdate', this.rooms[roomId]);
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
        this.server.to(roomId).emit('roomUpdate', Object.keys(this.rooms[roomId]));
      }
      delete this.socketUserMap[client.id];
      client.leave(roomId);
    }
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(client: Socket, { roomId, username }: { roomId: string; username: string }) {
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

    this.rooms[roomId][username] = '';
    this.socketUserMap[client.id] = { roomId, username };

    this.server.to(roomId).emit('roomUpdate', Object.keys(this.rooms[roomId]));

    client.emit('votesUpdate', this.rooms[roomId]);
    client.emit('roomState', {
      revealed: this.roomRevealStates[roomId] || false,
      votes: this.rooms[roomId],
    });
  }

  @SubscribeMessage('vote')
  handleVote(client: Socket, payload: VotePayload) {
    const { roomId, username, card } = payload;
    if (!this.rooms[roomId]) return;

    this.rooms[roomId][username] = card;

    // Emite para atualizar todos os clientes
    this.server.to(roomId).emit('votesUpdate', this.rooms[roomId]);
    this.server.to(roomId).emit('userVoted', username);
  }

  @SubscribeMessage('reset')
  handleReset(client: Socket, roomId: string) {
    if (!this.rooms[roomId]) return;

    for (const user in this.rooms[roomId]) {
      this.rooms[roomId][user] = '';
    }

    this.roomRevealStates[roomId] = false;
    this.server.to(roomId).emit('resetVotes');
  }

  @SubscribeMessage('reveal')
  handleReveal(client: Socket, roomId: string) {
    const roomVotes = this.rooms[roomId];
    if (roomVotes) {
      this.roomRevealStates[roomId] = true; // 👈 setar como revelado
      this.server.to(roomId).emit('revealVotes', roomVotes);
    }
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

    const currentVote = this.rooms[roomId][oldUsername];
    delete this.rooms[roomId][oldUsername];
    this.rooms[roomId][newUsername] = currentVote;

    this.socketUserMap[client.id].username = newUsername;

    this.server.to(roomId).emit('roomUpdate', Object.keys(this.rooms[roomId]));
  }
}
