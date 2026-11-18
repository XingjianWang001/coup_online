// 电脑玩家的表态（#58）：什么时候说、说哪条。和 computer.ts 并列，只看公开信息（ADR 0013）：
// 公开状态、本局公开事件，不读暗牌、性格、牌堆记忆。行动策略不读这里的任何东西，表态也不进 decideComputerIntent。
import type { Phrase } from '@coup/shared';

// 候选的一条：短语，或「我有 X」（claim，X 由各场景按语境定，必须在自己仍作数的声称里）
export type Line = Phrase | 'claim';
type Weights = Partial<Record<Line | 'silence', number>>;

// 场景表的一行：条件成立时给出带权重的候选。silence 是这一行对沉默的倍数（「多沉默」大于 1，「开口概率高」小于 1）
export interface Row<S> {
  when: (s: S) => boolean;
  say: Weights;
  exclude?: readonly Line[];
}

// 沉默的基础权重：一行三条候选（3 + 2 + 1.5）时开口约一半。起始值，靠试玩校准
const SILENCE = 8;

// 合并所有成立的行：同一条的权重相乘，任何一行写了排除就排除。沉默在每一行都是候选
export function merge<S>(rows: readonly Row<S>[], s: S): Map<Line | 'silence', number> {
  const weights = new Map<Line | 'silence', number>([['silence', SILENCE]]);
  const excluded = new Set<Line>();
  for (const row of rows.filter((r) => r.when(s))) {
    for (const [line, w] of Object.entries(row.say) as [Line | 'silence', number][]) weights.set(line, (weights.get(line) ?? 1) * w);
    row.exclude?.forEach((line) => excluded.add(line));
  }
  for (const line of excluded) weights.delete(line);
  return weights;
}
