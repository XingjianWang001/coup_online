import { readdir } from 'node:fs/promises';
import { dataPath, readRecords } from './data-file.ts';
import type { GameSummary } from './room.ts';
import { beijingDay, oldestVisitDay, VISITS_FILE, type VisitRecord } from './visits.ts';

type Summary = Pick<GameSummary, 'startedAt' | 'humans' | 'winner'> & { computers: unknown[] }; // 只看电脑几位

// 控制台统计。日期都按北京时间；gamesSince 为 null 时算上所有牌局摘要。访问文件本身只留 90 天，不再筛。
// 胜率按局：打完的局里真人、电脑各赢几局，两者相加就是打完的局数。地区按独立访客计，同一访客隔天再来算两次
export function summarizeStats(games: Summary[], visits: VisitRecord[], gamesSince: string | null) {
  const daily = new Map<string, { day: string; started: number; finished: number; visitors: Set<string> }>();
  const dayOf = (day: string) => daily.get(day) ?? daily.set(day, { day, started: 0, finished: 0, visitors: new Set() }).get(day)!;
  const humans: Record<number, number> = {};
  const computers: Record<number, number> = {};
  const winRate = { finished: 0, human: 0, computer: 0 };
  for (const g of games) {
    const day = beijingDay(new Date(g.startedAt));
    if (gamesSince && day < gamesSince) continue;
    const d = dayOf(day);
    d.started += 1;
    humans[g.humans] = (humans[g.humans] ?? 0) + 1;
    computers[g.computers.length] = (computers[g.computers.length] ?? 0) + 1;
    if (!g.winner) continue; // 中途结束：只算开局
    d.finished += 1;
    winRate.finished += 1;
    winRate[g.winner] += 1;
  }
  const funnel = { home: 0, createRoom: 0, joinLink: 0, joinCode: 0, startGame: 0 };
  const regions = new Map<string, Set<string>>();
  for (const v of visits) {
    const day = v.at.slice(0, 10);
    dayOf(day).visitors.add(v.visitor);
    const step = v.event === 'joinRoom' ? (v.via === 'link' ? 'joinLink' : 'joinCode') : v.event;
    if (step in funnel) funnel[step as keyof typeof funnel] += 1;
    (regions.get(v.region) ?? regions.set(v.region, new Set()).get(v.region)!).add(`${day} ${v.visitor}`);
  }
  return {
    daily: [...daily.values()].sort((a, b) => b.day.localeCompare(a.day)).map(({ visitors, ...d }) => ({ ...d, visitors: visitors.size })),
    funnel,
    humans,
    computers,
    winRate,
    regions: [...regions].map(([region, visitors]) => [region, visitors.size] as const).sort((a, b) => b[1] - a[1]),
  };
}

// ponytail: 每次请求都整读 games.jsonl 和 90 个访问文件；朋友圈规模的流量下几 MB 以内，不缓存
export async function readStats(all: boolean, now = new Date()) {
  const names = (await readdir(dataPath('')).catch(() => [] as string[])).filter((name) => VISITS_FILE.test(name));
  const visits = (await Promise.all(names.map((name) => readRecords(name)))).flat() as VisitRecord[];
  const since = oldestVisitDay(now);
  return { since: all ? null : since, ...summarizeStats((await readRecords('games.jsonl')) as Summary[], visits, all ? null : since) };
}
