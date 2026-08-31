import type { GameState } from '@coup/engine';

// 存储接口：MVP 用内存实现，未来换 SQLite/Redis 时替换实现即可。
export interface GameRepository {
  save(roomCode: string, state: GameState): void;
  load(roomCode: string): GameState | null;
  delete(roomCode: string): void;
}

export class InMemoryGameRepository implements GameRepository {
  private store = new Map<string, GameState>();

  save(roomCode: string, state: GameState): void {
    this.store.set(roomCode, state);
  }

  load(roomCode: string): GameState | null {
    return this.store.get(roomCode) ?? null;
  }

  delete(roomCode: string): void {
    this.store.delete(roomCode);
  }
}
