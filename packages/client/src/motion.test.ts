import { describe, expect, it } from 'vitest';
import { REVEAL_MS } from '@coup/shared';
import { REVEAL_STEPS_MS as step } from './motion.ts';

describe('showdown reveal timeline', () => {
  it('finishes before the server resumes the clock', () => {
    const truth = step.suspense + step.flip + step.verdict + step.toss + step.deal + step.settle + step.fade;
    const lie = step.suspense + step.flip + step.verdict + step.shrink;
    expect(Math.max(truth, lie)).toBeLessThanOrEqual(REVEAL_MS);
  });
});
