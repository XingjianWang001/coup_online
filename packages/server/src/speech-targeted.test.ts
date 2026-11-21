// packages/server/src/speech-targeted.test.ts
// 表 4（#79）：成为偷窃、暗杀、政变的目标时的表态与反预告
import { describe, expect, it } from 'vitest';
import { chooseAction, createGame, publicState, type GameEvent, type GameState, type Role } from '@coup/engine';
import type { Reaction } from '@coup/shared';
import { targeted, type Options } from './speech.ts';

// 一桌按真实流程推进的牌局：a 先手，did 记下引擎产生的事件，和 Room.gameEvents 一样
const IDS = ['a', 'b', 'c'];
function table(hands: Record<string, Role[]> = { a: ['duke', 'captain'], b: ['duke', 'assassin'], c: ['duke', 'contessa'] }) {
  const g: GameState = createGame(IDS.map((id) => ({ id, name: id })), { startingPlayerId: 'a', hands });
  const events: GameEvent[] = [];
  const did = (produced: GameEvent[]) => void events.push(...produced);
  const seat = (id: string) => g.players.find((p) => p.id === id)!;
  return { g, events, did, seat, act: (by: string, action: Parameters<typeof chooseAction>[2], target?: string) => did(chooseAction(g, by, action, target)) };
}
type Table = ReturnType<typeof table>;

// 候选写成可读的标签：短语用它的键，「我有 X」写作 claim:X，预告写作「行动>目标」，沉默是 silence
const label = (r: Reaction | null) =>
  r === null ? 'silence' : r.kind === 'phrase' ? r.phrase : r.kind === 'verbalClaim' ? `claim:${r.role}` : `${r.action}>${r.targetId}`;
const labels = (options: Options) => options.map(([r]) => label(r)).sort();
const moment = (t: Table, me = 'c') => targeted(publicState(t.g), t.events, me);

describe('表 4：成为偷窃、暗杀、政变的目标', () => {
  it.each<[string, (t: Table) => void, string[]]>([
    ['偷窃，没声称过：手下留情、你确定？、反预告（偷回去）', (t) => t.act('a', 'steal', 'c'), ['mercy', 'silence', 'steal>a', 'sure']],
  ])('%s', (_, setup, expected) => {
    const t = table();
    setup(t);
    const { options } = moment(t);
    expect(labels(options)).toEqual(expected);
    for (const [, weight] of options) expect(weight).toBeGreaterThan(0);
  });
});
