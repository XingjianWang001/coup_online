// packages/server/src/speech.test.ts
import { describe, expect, it } from 'vitest';
import { merge, type Row } from './speech.ts';

describe('场景表的合并', () => {
  it('成立的行合并候选：同一条的权重相乘，写了排除的不出现，沉默始终在候选里；不成立的行不算', () => {
    const rows: Row<{ on: boolean }>[] = [
      { when: () => true, say: { dare: 2, honest: 3 } },
      { when: () => true, say: { dare: 5, mercy: 1, silence: 4 }, exclude: ['honest'] },
      { when: ({ on }) => on, say: { respect: 1 } },
      { when: () => true, say: { honest: 7 } }, // 被上面的排除，不管写在哪一行之后
    ];
    const merged = merge(rows, { on: false });
    expect(merged.get('dare')).toBe(10);
    expect(merged.get('mercy')).toBe(1);
    expect(merged.has('honest')).toBe(false);
    expect(merged.has('respect')).toBe(false);
    // 沉默有基础权重，再乘上「多沉默」的那一行
    expect(merged.get('silence')! / merge([{ when: () => true, say: { dare: 1 } }], {}).get('silence')!).toBe(4);
  });
});
