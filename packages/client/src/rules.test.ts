import { describe, expect, it } from 'vitest';
import { actionName, roleName, rulesFor } from './rules.ts';

describe('official terminology', () => {
  it('uses the official role names in both locales', () => {
    expect(roleName('zh-CN', 'contessa')).toBe('女伯爵');
    expect(roleName('en', 'contessa')).toBe('Contessa');
  });

  it('uses the official names for all seven actions in both locales', () => {
    expect(['income', 'foreignAid', 'coup', 'tax', 'assassinate', 'steal', 'exchange'].map((action) =>
      actionName('en', action as Parameters<typeof actionName>[1]),
    )).toEqual(['Income', 'Foreign Aid', 'Coup', 'Tax', 'Assassinate', 'Steal', 'Exchange']);
    expect(['income', 'foreignAid', 'coup', 'tax', 'assassinate', 'steal', 'exchange'].map((action) =>
      actionName('zh-CN', action as Parameters<typeof actionName>[1]),
    )).toEqual(['收入', '外援', '政变', '征税', '暗杀', '偷窃', '交换']);
  });

  it('documents the official two-player starting-player coin rule in both locales', () => {
    expect(rulesFor('en')[0].body).toContain('starting player begins with 1 coin');
    expect(rulesFor('zh-CN')[0].body).toContain('起始玩家以 1 枚金币开局');
  });
});
