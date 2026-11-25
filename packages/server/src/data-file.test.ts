import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendRecord, readRecords } from './data-file.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coup-data-'));
  process.env.DATA_DIR = join(dir, 'nested');
});
afterEach(async () => {
  delete process.env.DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

it('appends one record per line under DATA_DIR and reads them back, skipping lines that do not parse', async () => {
  expect(await readRecords('games.jsonl')).toEqual([]);
  await appendRecord('games.jsonl', { n: 1 });
  await appendFile(join(dir, 'nested', 'games.jsonl'), 'not json\n');
  await appendRecord('games.jsonl', { n: 2 });
  await appendFile(join(dir, 'nested', 'games.jsonl'), '{"n":3'); // 进程崩溃时写了一半的最后一行
  expect(await readRecords('games.jsonl')).toEqual([{ n: 1 }, { n: 2 }]);
});
