import type { Role } from '@coup/shared';
import type { ActionType } from '@coup/shared';
import type { Locale } from './localization.ts';

export const ROLES: readonly Role[] = ['duke', 'assassin', 'captain', 'ambassador', 'contessa'];

const ROLE_NAMES: Record<Locale, Record<Role, string>> = {
  'zh-CN': { duke: '公爵', assassin: '刺客', captain: '队长', ambassador: '大使', contessa: '女伯爵' },
  en: { duke: 'Duke', assassin: 'Assassin', captain: 'Captain', ambassador: 'Ambassador', contessa: 'Contessa' },
};

const ACTION_NAMES: Record<Locale, Record<ActionType, string>> = {
  'zh-CN': { income: '收入', foreignAid: '外援', coup: '政变', tax: '征税', assassinate: '暗杀', steal: '偷窃', exchange: '交换' },
  en: { income: 'Income', foreignAid: 'Foreign Aid', coup: 'Coup', tax: 'Tax', assassinate: 'Assassinate', steal: 'Steal', exchange: 'Exchange' },
};

const ROLE_DESCRIPTIONS: Record<Locale, Record<Role, string>> = {
  'zh-CN': {
    duke: '征税：获得 3 金币；可阻挡外援。', assassin: '暗杀：支付 3 金币，指定一人失去 1 影响力。',
    captain: '偷窃：从一名玩家处偷取 2 金币；可阻挡偷窃。', ambassador: '交换：从牌堆抽 2 张并保留 2 张；可阻挡偷窃。', contessa: '反暗杀：可阻挡暗杀。',
  },
  en: {
    duke: 'Tax: take 3 coins; may block Foreign Aid.', assassin: 'Assassinate: pay 3 coins to make a player lose 1 influence.',
    captain: 'Steal: take 2 coins from a player; may block Steal.', ambassador: 'Exchange: draw 2 cards and keep 2; may block Steal.', contessa: 'May block Assassinate.',
  },
};

const RULES: Record<Locale, { title: string; body: string }[]> = {
  'zh-CN': [
    { title: '目标', body: '成为最后存活（仍有影响力）的玩家。每位玩家起始有 2 张暗牌（影响力）与 2 枚金币；两人局的起始玩家以 1 枚金币开局。' },
    { title: '行动', body: '轮到你可以选择：收入(+1)、外援(+2，可被公爵阻挡)、政变(7 金币，目标失去 1 影响力)、或声称某个角色发动其能力。' },
    { title: '质疑', body: '任何声称角色（含阻挡）都能被其他玩家质疑。若被质疑者确实持有该角色，质疑者失去 1 影响力，被质疑者将牌放回牌堆重抽一张；若在撒谎，被质疑者失去 1 影响力，行动作废。' },
    { title: '阻挡', body: '外援可被公爵阻挡；暗杀可被女伯爵阻挡；偷窃可被队长或大使阻挡。阻挡本身也是声称，可被质疑。' },
    { title: '失去影响力', body: '每次失去影响力时，自己选择一张暗牌公开翻开。暗牌归零即被淘汰。' },
  ],
  en: [
    { title: 'Objective', body: 'Be the last player with influence. Each player starts with 2 hidden cards (influence) and 2 coins; in a two-player game, the starting player begins with 1 coin.' },
    { title: 'Actions', body: 'On your turn choose Income (+1), Foreign Aid (+2, blockable by Duke), Coup (7 coins; the target loses 1 influence), or claim a role to use its action.' },
    { title: 'Challenge', body: 'Any role claim, including a Block, may be challenged. A truthful claimant replaces the shown card and the challenger loses 1 influence; a bluffing claimant loses 1 influence and the action is canceled.' },
    { title: 'Block', body: 'Duke blocks Foreign Aid; Contessa blocks Assassinate; Captain or Ambassador blocks Steal. A Block is also a claim and may be challenged.' },
    { title: 'Losing influence', body: 'When you lose influence, choose one hidden card to reveal. A player with no hidden cards is eliminated.' },
  ],
};

export const roleName = (locale: Locale, role: Role): string => ROLE_NAMES[locale][role];
export const actionName = (locale: Locale, action: ActionType): string => ACTION_NAMES[locale][action];
export const roleDescription = (locale: Locale, role: Role): string => ROLE_DESCRIPTIONS[locale][role];
export const rulesFor = (locale: Locale): readonly { title: string; body: string }[] => RULES[locale];
