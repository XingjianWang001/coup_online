// 控制台页面（#116）：每个牌局阶段都有中文名，不把 choosingAction 之类原样显示出来
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { Phase } from '@coup/engine';

// Record 的键必须恰好是全部阶段：引擎加了新阶段，这里先编译不过
const phases: Record<Phase | 'lobby', true> = {
  lobby: true, choosingAction: true, awaitingChallenge: true, showdown: true, awaitingBlock: true, choosingLoss: true, choosingExchange: true, gameOver: true,
};

it('页面给每个阶段一个中文名', () => {
  const page = readFileSync(new URL('./console.html', import.meta.url), 'utf8');
  const PHASE = new Function(`return ${/const PHASE = (\{[^}]*\});/.exec(page)?.[1]}`)() as Record<string, string>;
  for (const phase of Object.keys(phases)) expect(PHASE[phase], phase).toMatch(/^[一-鿿]+$/);
});
