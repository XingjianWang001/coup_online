import { ClientError } from './errors.ts';

const MAX_ROOMS = 100;
const CREATE_WINDOW_MS = 60_000;
const MAX_CREATES_PER_WINDOW = 5;
const creationWindows = new Map<string, { start: number; count: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [address, window] of creationWindows) {
    if (now - window.start >= CREATE_WINDOW_MS) creationWindows.delete(address);
  }
}, CREATE_WINDOW_MS).unref();

// ponytail: A single process and fixed window allow bursts at minute boundaries; use a shared sliding window if multiple replicas or abuse require it.
// ponytail: 100 live rooms is a conservative cap for 2 GB; raise it from measured memory use if legitimate games hit the limit.
export function reserveRoomCreation(address: string, roomCount: number): void {
  if (roomCount >= MAX_ROOMS) throw new ClientError({ code: 'serverBusy' });
  const now = Date.now();
  const window = creationWindows.get(address);
  if (!window || now - window.start >= CREATE_WINDOW_MS) {
    creationWindows.set(address, { start: now, count: 1 });
  } else {
    if (window.count >= MAX_CREATES_PER_WINDOW) throw new ClientError({ code: 'rateLimited' });
    window.count += 1;
  }
}
