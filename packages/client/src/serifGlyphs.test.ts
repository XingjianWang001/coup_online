import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { serifText } from './serifGlyphs.ts';

describe('serif subset', () => {
  it('covers every glyph the serif renders', () => {
    const packed = readFileSync(new URL('../public/fonts/noto-serif-sc-600.txt', import.meta.url), 'utf8');
    const missing = [...serifText()].filter((c) => !packed.includes(c));
    expect(missing, 'run node scripts/serif-subset.mjs').toEqual([]);
  });
});
