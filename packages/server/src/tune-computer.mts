// 强电脑的自对弈调参（ADR 0014）：(μ/μw, λ) 进化策略在归一化参数空间里找胜率最高的 Tuning，起点是 STANDARD。
// 主进程跑进化，子进程（fork 自己，每核一个）各自打牌评估一个候选。适应度是候选坐在各评测场里相对 STANDARD 的胜率提升。
// 用法：pnpm --filter @coup/server tune；环境变量 GENS 代数（默认 60）、GAMES 每个候选每场的局数（默认 600）、FROM=strong 从现有 STRONG 接着调、SIGMA 起始步长（默认 0.15）。
// 24 核上 GENS=80 GAMES=800 约 20 分钟。最后打印的 JSON 抄进 computer.ts 的 STRONG，再跑 computer.test.ts 的胜率检查
import { fork } from 'node:child_process';
import { cpus } from 'node:os';
import {
  block, challenge, chooseAction, createGame, passBlock, passChallenge, privateState, publicState,
  resolveExchange, resolveLoss, revealShowdownCard, COUP_COST, type GameEvent, type GameState,
} from '@coup/engine';
import { STANDARD, STRONG, decideComputerIntent, drawTemperament, type ComputerIntent, type Returned, type Temperament, type Tuning } from './computer.ts';

// ---------- 参数空间 ----------
// [路径, 下界, 上界, 整数?]
const SPACE: [string, number, number, boolean?][] = [
  ['WORTH.duke', 0, 8], ['WORTH.captain', 0, 8], ['WORTH.assassin', 0, 8], ['WORTH.contessa', 0, 8], ['WORTH.ambassador', 0, 8],
  ['THREAT', 0, 4], ['HARM.foreignAid', 0, 3], ['HARM.steal', 0, 3], ['HARM.assassinate', 0, 4],
  ['BYSTANDER', 0, 1], ['GRATITUDE', 0, 2], ['ALLY', 0, 5], ['RECIPROCITY', 0, 1],
  ['NEW_BLUFF', 0, 1], ['FAKE_BLOCK.foreignAid', 0, 1], ['FAKE_BLOCK.steal', 0, 1], ['FAKE_BLOCK.assassinate', 0, 1],
  ['REPEAT_BLUFF', 0, 4], ['STORY_ROLES', 2, 5, true], ['COUP_EAGERNESS', 0, 1], ['GUARDED', 0, 1], ['SLOWPLAY', 0, 1],
  ['CONTRADICTION', 1, 10], ['PROVEN_FLOOR', 0, 1], ['STRUGGLE', 0, 6], ['COUP_HARM', 0, 4], ['RESTRAINT', 0, 1],
  ['ACTION_WEIGHT.income', 0, 8], ['ACTION_WEIGHT.foreignAid', 0, 8], ['ACTION_WEIGHT.tax', 0, 10], ['ACTION_WEIGHT.steal', 0, 8],
  ['ACTION_WEIGHT.assassinate', 0, 8], ['ACTION_WEIGHT.exchange', 0, 8], ['AGGRESSION_WEIGHT.steal', 0, 8], ['AGGRESSION_WEIGHT.assassinate', 0, 8],
  ['DOUBT_BASE', 0, 0.3], ['DOUBT_SLOPE', 0, 0.3], ['DOUBT_CAP', 0.3, 1], ['DECK_MEMORY', 0, 2],
  ['TEMPERAMENT.bluff.0', 0, 1], ['TEMPERAMENT.bluff.1', 0, 1], ['TEMPERAMENT.suspicion.0', 0, 1], ['TEMPERAMENT.suspicion.1', 0, 1],
  ['TEMPERAMENT.aggression.0', 0, 1], ['TEMPERAMENT.aggression.1', 0, 1],
];
const get = (o: any, path: string) => path.split('.').reduce((a, k) => a[k], o);
const clamp = (x: number) => Math.min(1, Math.max(0, x));
function encode(t: Tuning): number[] {
  return SPACE.map(([p, lo, hi]) => clamp((get(t, p) - lo) / (hi - lo)));
}
function decode(x: number[]): Tuning {
  const t: any = structuredClone(STANDARD);
  SPACE.forEach(([p, lo, hi, int], i) => {
    const keys = p.split('.');
    const last = keys.pop()!;
    let v = lo + clamp(x[i]) * (hi - lo);
    if (int) v = Math.round(v);
    keys.reduce((a, k) => a[k], t)[last] = v;
  });
  for (const k of ['bluff', 'suspicion', 'aggression']) t.TEMPERAMENT[k] = [...t.TEMPERAMENT[k]].sort((a: number, b: number) => a - b);
  return t;
}

// ---------- 打牌 ----------
function apply(g: GameState, id: string, i: ComputerIntent) {
  switch (i.type) {
    case 'chooseAction': return chooseAction(g, id, i.action, i.targetId);
    case 'challenge': return challenge(g, id);
    case 'passChallenge': return passChallenge(g, id);
    case 'block': return block(g, id, i.role);
    case 'passBlock': return passBlock(g, id);
    case 'revealShowdownCard': return revealShowdownCard(g, id, i.cardId);
    case 'resolveLoss': return resolveLoss(g, id, i.cardId);
    case 'resolveExchange': return resolveExchange(g, id, i.keepIds);
  }
}
type Kind = 'hero' | 'standard' | 'credulous' | 'spammer' | 'honest';
function seatIntent(kind: Kind, g: GameState, id: string, ev: GameEvent[], t: Temperament, tuning: Tuning, returned: Returned[]): ComputerIntent | null {
  const i = decideComputerIntent(publicState(g), privateState(g, id), ev, t, Math.random, kind === 'hero' ? tuning : STANDARD, returned);
  if (kind === 'credulous' && i?.type === 'challenge') return { type: 'passChallenge' };
  if (kind === 'spammer' && i?.type === 'chooseAction' && g.players.find((p) => p.id === id)!.coins < COUP_COST) return { type: 'chooseAction', action: 'tax' };
  return i;
}
const HONEST: Temperament = { bluff: 0, suspicion: 0, aggression: 0.5 };
// 一个座位是 hero，返回 hero 胜率
function arena(kinds: Kind[], games: number, tuning: Tuning): number {
  const ids = kinds.map((_, i) => `p${i}`);
  let wins = 0;
  for (let k = 0; k < games; k++) {
    const g = createGame(ids.map((id) => ({ id, name: id })), { startingPlayerId: ids[k % ids.length] });
    const temps = kinds.map((kind) => (kind === 'honest' ? HONEST : drawTemperament(Math.random, kind === 'hero' ? tuning : STANDARD)));
    const events: GameEvent[] = [];
    const returned = ids.map((): Returned[] => []);
    let steps = 0;
    while (g.phase !== 'gameOver' && steps++ < 3000) {
      const ds = ids.flatMap((id, i) => {
        const it = seatIntent(kinds[i], g, id, events, temps[i], tuning, returned[i]);
        return it ? [{ id, it }] : [];
      });
      const { id, it } = ds[Math.floor(Math.random() * ds.length)];
      // 和 Room 一样记下交换时放回牌堆的牌；没人弃权，交换选牌时最后一条事件就是这次 exchangeDrew
      if (it.type === 'resolveExchange') {
        returned[ids.indexOf(id)].push({ at: events.length - 1, roles: privateState(g, id).hand.filter((c) => !it.keepIds.includes(c.id)).map((c) => c.role) });
      }
      events.push(...apply(g, id, it)!);
    }
    if (g.winnerId === 'p0') wins++;
  }
  return wins / games;
}
// 评测场：hero 坐 p0
export const FIELDS: [string, Kind[], number][] = [
  ['4p vs standard', ['hero', 'standard', 'standard', 'standard'], 1],
  ['2p vs standard', ['hero', 'standard'], 1],
  ['4p vs mixed exploiters', ['hero', 'credulous', 'spammer', 'standard'], 1],
  ['3p vs honest+standard', ['hero', 'honest', 'standard'], 1],
  ['6p vs standard', ['hero', 'standard', 'standard', 'standard', 'standard', 'standard'], 1],
];

// ---------- 子进程 ----------
if (process.env.TUNE_WORKER) {
  process.on('message', ({ id, x, games, fields }: { id: number; x: number[]; games: number; fields: number[] }) => {
    const tuning = decode(x);
    const rates = fields.map((f) => arena(FIELDS[f][1], games, tuning));
    process.send!({ id, rates });
  });
} else {
  const N = Math.max(1, cpus().length - 2);
  const workers = Array.from({ length: N }, () => fork(process.argv[1], [], { env: { ...process.env, TUNE_WORKER: '1' } }));
  const idle = [...workers];
  const waiting: (() => void)[] = [];
  let seq = 0;
  const pending = new Map<number, (r: number[]) => void>();
  for (const w of workers) w.on('message', ({ id, rates }: any) => { pending.get(id)!(rates); pending.delete(id); idle.push(w); waiting.shift()?.(); });
  // 一个评估拆成多块并行
  async function job(x: number[], games: number, fields: number[]): Promise<number[]> {
    while (!idle.length) await new Promise<void>((r) => waiting.push(r));
    const w = idle.pop()!;
    const id = seq++;
    return new Promise((r) => { pending.set(id, r); w.send({ id, x, games, fields }); });
  }
  async function evaluate(x: number[], games: number, chunks = 1): Promise<number[]> {
    const fields = FIELDS.map((_, i) => i);
    const parts = await Promise.all(Array.from({ length: chunks }, () => job(x, Math.ceil(games / chunks), fields)));
    return fields.map((_, f) => parts.reduce((s, p) => s + p[f], 0) / chunks);
  }

  const base = await evaluate(encode(STANDARD), 4000, N);
  console.log('baseline (STANDARD as hero):', FIELDS.map(([n], i) => `${n} ${base[i].toFixed(3)}`).join(' | '));
  // 适应度：各场相对基线的提升取平均，再加最差那场的一半，免得牺牲某一场
  const fitness = (r: number[]) => {
    const gains = r.map((v, i) => (v - base[i]) / base[i]);
    return gains.reduce((a, b) => a + b, 0) / gains.length + 0.5 * Math.min(...gains);
  };

  const D = SPACE.length;
  const lambda = N;
  const mu = Math.floor(lambda / 3);
  const w = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
  const wsum = w.reduce((a, b) => a + b, 0);
  let mean = encode(process.env.FROM === 'strong' ? STRONG : STANDARD);
  let sigma = Number(process.env.SIGMA ?? 0.15);
  const GENS = Number(process.env.GENS ?? 60);
  const GAMES = Number(process.env.GAMES ?? 600);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  for (let gen = 0; gen < GENS; gen++) {
    const pop = Array.from({ length: lambda }, () => mean.map((m) => clamp(m + sigma * gauss())));
    const rates = await Promise.all(pop.map((x) => job(x, GAMES, FIELDS.map((_, i) => i))));
    const ranked = pop.map((x, i) => ({ x, f: fitness(rates[i]), r: rates[i] })).sort((a, b) => b.f - a.f);
    mean = Array.from({ length: D }, (_, d) => ranked.slice(0, mu).reduce((s, c, i) => s + (w[i] / wsum) * c.x[d], 0));
    sigma = Math.max(0.03, sigma * 0.97);
    if (gen % 5 === 4 || gen === GENS - 1) {
      const r = await evaluate(mean, 1200, N);
      console.log(`gen ${gen + 1} sigma ${sigma.toFixed(3)} mean:`, FIELDS.map((_, i) => `${r[i].toFixed(3)}`).join(' '), 'fit', fitness(r).toFixed(3));
    }
  }
  const final = await evaluate(mean, 12000, N);
  console.log('FINAL mean:', FIELDS.map(([n], i) => `${n} ${final[i].toFixed(3)} (base ${base[i].toFixed(3)})`).join(' | '));
  console.log(JSON.stringify(decode(mean)));
  for (const wk of workers) wk.kill();
}
