import { describe, expect, it, vi } from 'vitest';
import { ClientError, toServerError } from './errors.ts';

describe('server error boundary', () => {
  it('preserves a known structured error without logging it as unexpected', () => {
    const log = vi.fn();
    const error = new ClientError({ code: 'minimumPlayers', params: { minimum: 2 } });

    expect(toServerError(error, log)).toEqual({
      code: 'minimumPlayers',
      params: { minimum: 2 },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('logs unexpected diagnostic detail but returns only a generic error code', () => {
    const log = vi.fn();
    const failure = new Error('database password leaked');

    const result = toServerError(failure, log);

    expect(result).toEqual({ code: 'unexpected' });
    expect(JSON.stringify(result)).not.toContain(failure.message);
    expect(log).toHaveBeenCalledWith('unexpected server error', failure);
  });
});
