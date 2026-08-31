import type { Role } from '@coup/shared';

export const ROLE_NAMES: Record<Role, string> = {
  duke: '公爵',
  assassin: '刺客',
  captain: '队长',
  ambassador: '大使',
  contessa: '女伯爵',
};

export const ROLE_DESC: Record<Role, string> = {
  duke: '征税：获得 3 金币；可阻挡外援。',
  assassin: '暗杀：支付 3 金币，指定一人失去 1 影响力。',
  captain: '偷窃：从一名玩家处偷取 2 金币；可阻挡偷窃。',
  ambassador: '交换：从牌堆抽 2 张并保留 2 张；可阻挡偷窃。',
  contessa: '反暗杀：可阻挡暗杀。',
};

export const RULES = [
  { title: '目标', body: '成为最后存活（仍有影响力）的玩家。每位玩家起始有 2 张暗牌（影响力）与 2 金币。' },
  { title: '行动', body: '轮到你可以选择：收入(+1)、外援(+2，可被公爵阻挡)、政变(7 金币，目标失去 1 影响力)、或声称某个角色发动其能力。' },
  { title: '质疑', body: '任何声称角色（含阻挡）都能被其他玩家质疑。若被质疑者确实持有该角色，质疑者失去 1 影响力，被质疑者将牌放回牌堆重抽一张；若在撒谎，被质疑者失去 1 影响力，行动作废。' },
  { title: '阻挡', body: '外援可被公爵阻挡；暗杀可被女伯爵阻挡；偷窃可被队长或大使阻挡。阻挡本身也是声称，可被质疑。' },
  { title: '失去影响力', body: '每次失去影响力时，自己选择一张暗牌公开翻开。暗牌归零即被淘汰。' },
];
