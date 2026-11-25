import { describe, expect, it } from 'vitest';
import { normalizeRoomCode } from './Entry.tsx';

describe('normalizeRoomCode', () => {
  it('从聊天里复制来的空格和标点不占房间码的位数', () => {
    expect(normalizeRoomCode(' ab12cd ')).toBe('AB12CD');
    expect(normalizeRoomCode('ab 12-cd')).toBe('AB12CD');
  });

  it('粘贴整条加入链接时取出房间码', () => {
    expect(normalizeRoomCode('https://coup.example.com/?room=ab12cd')).toBe('AB12CD');
    expect(normalizeRoomCode('来玩 https://coup.example.com/?lang=zh&room=ab12cd&x=1 快')).toBe('AB12CD');
  });

  it('只保留前 6 位', () => {
    expect(normalizeRoomCode('abcdefg')).toBe('ABCDEF');
  });
});
