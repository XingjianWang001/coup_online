import { describe, expect, it } from 'vitest';
import { parseClientIntent, parseServerError } from './protocol.ts';

describe('server error protocol', () => {
  it('preserves the required parameters for known parameterized errors', () => {
    expect(parseServerError({ code: 'minimumPlayers', params: { minimum: 2 } })).toEqual({
      code: 'minimumPlayers',
      params: { minimum: 2 },
    });
    expect(parseServerError({ code: 'roomFull', params: { maximum: 6 } })).toEqual({
      code: 'roomFull',
      params: { maximum: 6 },
    });
  });

  it('falls back to unexpected for unknown codes and invalid parameter shapes', () => {
    expect(parseServerError({ code: 'futureError', message: 'internal detail' })).toEqual({
      code: 'unexpected',
    });
    expect(parseServerError({ code: 'roomFull', params: { maximum: 'six' } })).toEqual({
      code: 'unexpected',
    });
  });
});

describe('client intent protocol', () => {
  it('keeps well-formed intents and drops fields it does not know', () => {
    expect(parseClientIntent({ type: 'chooseAction', action: 'steal', targetId: 'p2', extra: 1 })).toEqual({
      type: 'chooseAction',
      action: 'steal',
      targetId: 'p2',
    });
    expect(parseClientIntent({ type: 'react', reaction: { kind: 'phrase', phrase: 'sure', text: '自写文字' } })).toEqual({
      type: 'react',
      reaction: { kind: 'phrase', phrase: 'sure' },
    });
    expect(parseClientIntent({ type: 'focusShowdownCard', slot: null })).toEqual({ type: 'focusShowdownCard', slot: null });
    expect(parseClientIntent({ type: 'resolveExchange', keepIds: ['a', 'b'] })).toEqual({ type: 'resolveExchange', keepIds: ['a', 'b'] });
  });

  it('reads a join without a valid source as one by Room Code, so older clients still join', () => {
    expect(parseClientIntent({ type: 'joinRoom', roomCode: 'ABC123', name: 'Alice', via: 'link' })).toMatchObject({ via: 'link' });
    expect(parseClientIntent({ type: 'joinRoom', roomCode: 'ABC123', name: 'Alice' })).toMatchObject({ via: 'code' });
    expect(parseClientIntent({ type: 'joinRoom', roomCode: 'ABC123', name: 'Alice', via: 'qr' })).toMatchObject({ via: 'code' });
  });

  it.each([
    null,
    'createRoom',
    { type: 'futureIntent' },
    { type: 'createRoom' },
    { type: 'joinRoom', roomCode: 123456, name: 'Alice' },
    { type: 'chooseAction', action: 'nap' },
    { type: 'chooseAction', action: 'steal', targetId: 7 },
    { type: 'block', role: 'king' },
    { type: 'setComputerStrength', playerId: 'c1', strength: 'godlike' },
    { type: 'revealShowdownCard' },
    { type: 'focusShowdownCard', slot: '0' },
    { type: 'focusShowdownCard', slot: -1 },
    { type: 'focusShowdownCard', slot: 0.5 },
    { type: 'resolveExchange', keepIds: null },
    { type: 'resolveExchange', keepIds: 'ab' },
    { type: 'resolveExchange', keepIds: { length: 2 } },
    { type: 'resolveExchange', keepIds: ['a', 2] },
    { type: 'react', reaction: null },
    { type: 'react', reaction: 'sure' },
    { type: 'react', reaction: { kind: 'phrase', phrase: '随便写点什么' } },
    { type: 'react', reaction: { kind: 'phrase', phrase: 'framed' } },
    { type: 'react', reaction: { kind: 'phrase' } },
    { type: 'react', reaction: { kind: 'chat', text: 'hello' } },
    { type: 'react', reaction: { kind: 'announcement', action: 'nap' } },
    { type: 'react', reaction: { kind: 'verbalClaim', has: true, role: 'king' } },
    { type: 'react', reaction: { kind: 'verbalClaim', has: 'yes', role: 'duke' } },
  ])('rejects malformed intent %j', (raw) => {
    expect(parseClientIntent(raw)).toBeNull();
  });
});
