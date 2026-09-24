import type { ServerError } from '@coup/shared';

export class ClientError extends Error {
  constructor(readonly payload: ServerError, options?: ErrorOptions) {
    super(payload.code, options);
    this.name = 'ClientError';
  }
}

export function toServerError(
  error: unknown,
  log: (message: string, detail: unknown) => void = console.error,
): ServerError {
  if (error instanceof ClientError) return error.payload;
  log('unexpected server error', error);
  return { code: 'unexpected' };
}
