import { describe, expect, it } from 'vitest';
import { parseServerError } from './protocol.ts';

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
