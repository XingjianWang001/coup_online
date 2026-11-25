import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readRecords } from './data-file.ts';
import { pruneVisits, recordVisit, regionOf, visitorOf } from './visits.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coup-visits-'));
  process.env.DATA_DIR = dir;
});
afterEach(async () => {
  delete process.env.DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

it('resolves mainland IPs to the city, foreign IPs to the country (in Chinese), local addresses to 本机', () => {
  expect(regionOf('120.24.78.68')).toBe('深圳市');
  expect(regionOf('::ffff:223.5.5.5')).toBe('杭州市');
  expect(regionOf('8.8.8.8')).toBe('美国');
  expect(regionOf('1.1.1.1')).toBe('澳大利亚');
  for (const local of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.18.0.1']) expect(regionOf(local)).toBe('本机');
  expect(regionOf('not an ip')).toBe('未知');
});

it('gives the same IP the same visitor hash all day (UTC+8) and a different one after the key changes at midnight', () => {
  const morning = visitorOf('120.24.78.68', new Date('2026-11-24T00:00+08:00'));
  expect(visitorOf('120.24.78.68', new Date('2026-11-24T23:59+08:00'))).toBe(morning);
  expect(visitorOf('223.5.5.5', new Date('2026-11-24T12:00+08:00'))).not.toBe(morning);
  expect(visitorOf('120.24.78.68', new Date('2026-11-25T00:00+08:00'))).not.toBe(morning);
});

it('appends a visit to that Beijing day\'s file with the hour, region and visitor hash but not the IP', async () => {
  const now = new Date('2026-11-24T16:30:00Z'); // 北京时间 25 日 00:30
  await recordVisit('120.24.78.68', { event: 'joinRoom', via: 'link' }, now);
  expect(await readRecords('visits-2026-11-25.jsonl')).toEqual([
    { at: '2026-11-25T00:00+08:00', event: 'joinRoom', via: 'link', region: '深圳市', visitor: visitorOf('120.24.78.68', now) },
  ]);
  expect(await readFile(join(dir, 'visits-2026-11-25.jsonl'), 'utf8')).not.toContain('120.24');
});

it('deletes whole visit files once they are more than 90 days old, leaving other files alone', async () => {
  for (const name of ['visits-2026-08-26.jsonl', 'visits-2026-08-27.jsonl', 'visits-2026-11-24.jsonl', 'games.jsonl']) await writeFile(join(dir, name), '');
  await pruneVisits(new Date('2026-11-24T00:30+08:00'));
  expect((await readdir(dir)).sort()).toEqual(['games.jsonl', 'visits-2026-08-27.jsonl', 'visits-2026-11-24.jsonl']);
});
