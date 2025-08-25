import { Module } from '@nestjs/common';
import { PokerGateway } from './poker/poker.gateway';

@Module({
  imports: [],
  providers: [PokerGateway],
})
export class AppModule {}
