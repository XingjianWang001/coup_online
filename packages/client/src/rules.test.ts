import { describe, expect, it } from 'vitest';
import { actionName, roleDescription, roleName, rulesFor, type RuleLevel } from './rules.ts';

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

  it('keeps role summaries accurate after Influence is lost', () => {
    expect(roleDescription('en', 'captain')).toContain('up to 2 coins');
    expect(roleDescription('en', 'ambassador')).toContain('shuffle 2 back');
    expect(roleDescription('zh-CN', 'captain')).toContain('至多 2 金币');
    expect(roleDescription('zh-CN', 'ambassador')).toContain('将 2 张洗回牌堆');
  });
});

describe('bilingual rules center', () => {
  const sectionIds = (locale: 'zh-CN' | 'en', level: RuleLevel) =>
    rulesFor(locale, level).map((section) => section.id);

  it('selects localized Quick and Full content independently', () => {
    expect(rulesFor('en', 'quick')[0]).toMatchObject({ id: 'objective', title: 'Objective' });
    expect(rulesFor('zh-CN', 'quick')[0]).toMatchObject({ id: 'objective', title: '目标' });
    expect(rulesFor('en', 'full').some((section) => section.id === 'setup')).toBe(true);
    expect(rulesFor('zh-CN', 'full').some((section) => section.id === 'setup')).toBe(true);
  });

  it('keeps matching rule identifiers in both locales', () => {
    for (const level of ['quick', 'full'] as const) {
      expect(sectionIds('zh-CN', level)).toEqual(sectionIds('en', level));
    }
  });

  it('includes every required Quick Rules section and all seven actions', () => {
    expect(sectionIds('en', 'quick')).toEqual(expect.arrayContaining([
      'objective', 'influence-and-turns', 'actions', 'claims', 'challenges', 'blocks', 'mandatory-coup', 'online-play',
    ]));
    const actions = rulesFor('en', 'quick').find((section) => section.id === 'actions')!;
    expect(actions.items).toEqual(expect.arrayContaining([
      expect.stringContaining('Income'),
      expect.stringContaining('Foreign Aid'),
      expect.stringContaining('Coup'),
      expect.stringContaining('Tax'),
      expect.stringContaining('Assassinate'),
      expect.stringContaining('Steal'),
      expect.stringContaining('Exchange'),
    ]));
  });

  it('includes every required Full Rules section', () => {
    expect(sectionIds('en', 'full')).toEqual(expect.arrayContaining([
      'setup', 'influence', 'turn-flow', 'general-actions', 'role-actions', 'blocks',
      'challenges', 'truthful-claim', 'successful-challenge', 'assassination-danger', 'negotiation', 'online-play',
    ]));
  });

  it('documents the standard two-player starting-coin rule in both locales', () => {
    expect(rulesFor('en', 'full').find((section) => section.id === 'setup')?.body)
      .toContain('starting player begins with 1 coin');
    expect(rulesFor('zh-CN', 'full').find((section) => section.id === 'setup')?.body)
      .toContain('起始玩家以 1 枚金币开局');
  });

  it('keeps random starting-player selection in online-play rules', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const setup = rulesFor(locale, 'full').find((section) => section.id === 'setup')!;
      const online = rulesFor(locale, 'full').find((section) => section.id === 'online-play')!;
      expect(setup.body).not.toMatch(/随机|random/);
      expect(online.items?.join(' ')).toMatch(/随机|random/);
    }
  });
});
