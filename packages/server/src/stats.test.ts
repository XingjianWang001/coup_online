// 控制台统计（#116、ADR 0015）：由 games.jsonl 与 visits-*.jsonl 的记录汇总
import { expect, it } from 'vitest';
import { summarizeStats } from './stats.ts';
import type { VisitRecord } from './visits.ts';

const game = (startedAt: string, humans: number, computers: string[], winner: 'human' | 'computer' | null) => ({
  startedAt,
  endedAt: startedAt,
  humans,
  computers,
  endedEarly: !winner,
  winner,
});
const games = [
  game('2026-11-23T15:30:00.000Z', 1, ['standard', 'strong'], 'human'), // 北京时间 23:30
  game('2026-11-23T16:30:00.000Z', 2, ['standard'], 'computer'), // 北京时间 24 日 00:30
  game('2026-11-24T02:00:00.000Z', 1, [], null), // 中途结束
  game('2026-08-01T02:00:00.000Z', 3, [], 'human'), // 90 天以前
];
const visits: VisitRecord[] = [
  { at: '2026-11-23T23:00+08:00', event: 'home', region: '深圳市', visitor: 'a' },
  { at: '2026-11-23T23:00+08:00', event: 'createRoom', region: '深圳市', visitor: 'a' },
  { at: '2026-11-23T23:00+08:00', event: 'joinRoom', via: 'link', region: '杭州市', visitor: 'b' },
  { at: '2026-11-23T23:00+08:00', event: 'startGame', region: '深圳市', visitor: 'a' },
  { at: '2026-11-24T10:00+08:00', event: 'home', region: '深圳市', visitor: 'c' },
  { at: '2026-11-24T10:00+08:00', event: 'joinRoom', via: 'code', region: '深圳市', visitor: 'c' },
];

it('最近 90 天：每日开局、打完、独立访客，漏斗，人数分布，按局的胜率（打完的局里真人、电脑各赢几局），按访客的地区分布；中途结束只算开局', () => {
  expect(summarizeStats(games, visits, '2026-08-27')).toEqual({
    daily: [
      { day: '2026-11-24', started: 2, finished: 1, visitors: 1 },
      { day: '2026-11-23', started: 1, finished: 1, visitors: 2 },
    ],
    funnel: { home: 2, createRoom: 1, joinLink: 1, joinCode: 1, startGame: 1 },
    humans: { 1: 2, 2: 1 },
    computers: { 0: 1, 1: 1, 2: 1 },
    winRate: { finished: 2, human: 1, computer: 1 },
    regions: [['深圳市', 2], ['杭州市', 1]],
  });
});

it('牌局摘要切到「全部」时算上 90 天以前的牌局，访问不变', () => {
  const all = summarizeStats(games, visits, null);
  expect(all.daily.at(-1)).toEqual({ day: '2026-08-01', started: 1, finished: 1, visitors: 0 });
  expect(all.winRate).toEqual({ finished: 3, human: 2, computer: 1 });
  expect(all.funnel.home).toBe(2);
});
