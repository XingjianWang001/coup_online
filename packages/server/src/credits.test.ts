import { expect, it } from 'vitest';
import { creditsFor } from './credits.ts';

it('returns only the credits for the requested site and language, with a separate default roster', () => {
  const fallback = { name: 'Example alias', contribution: 'Development' };
  const artist = { name: 'Example artist', contribution: 'Card art' };
  const translated = { name: '示例画师', contribution: '绘制牌面' };
  const roster = {
    '*': { en: [fallback], 'zh-CN': [] },
    'cards.example': { en: [fallback, artist], 'zh-CN': [translated] },
    'game.example': { en: [], 'zh-CN': [] },
  };
  expect(creditsFor(roster, 'CARDS.example:8080', 'en')).toEqual([fallback, artist]);
  expect(creditsFor(roster, 'cards.example', 'zh-CN')).toEqual([translated]);
  expect(creditsFor(roster, 'game.example', 'en')).toEqual([]);
  expect(creditsFor(roster, 'localhost', 'en')).toEqual([fallback]);
  expect(creditsFor({}, 'localhost', 'en')).toEqual([]);
});
