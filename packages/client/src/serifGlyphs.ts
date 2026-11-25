import { LOCALES, translate, type Locale, type MessageKey } from './localization.ts';
import { ROLES, roleName, roleShortName } from './rules.ts';

// 衬线展示字体只打包这些字的字形：public/fonts/noto-serif-sc-600.woff2，由 scripts/serif-subset.mjs 生成，
// 打进去的字记在同名 .txt 里。新增用衬线渲染的固定文字（h1、h2、舞台标题、印章、牌名）时加到这里并重跑脚本，
// serifGlyphs.test.ts 会在字形缺失时失败。玩家昵称不用衬线（.stage-name），不在此列
const SERIF_KEYS: MessageKey[] = [
  'appTitle',
  'settingsTitle',
  'credits',
  'rulesTitle',
  'showdownTitle',
  'showdownTitleYou',
  'showdownTitleByYou',
  'lossTitle',
  'exchangePrompt',
  'challengeFailed',
  'challengeSucceeded',
];

const message = translate as (locale: Locale, key: MessageKey) => string;

export function serifText(): string {
  const text = LOCALES.flatMap((locale) => [
    ...SERIF_KEYS.map((key) => message(locale, key).replace(/\{\w+\}/g, '')),
    ...ROLES.flatMap((role) => [roleName(locale, role), roleShortName(locale, role) ?? '']),
  ]).join('') + '0123456789'; // exchangePrompt 的张数
  // 弯引号不打包：中文字体里是全宽字形，英文「Bot’s」会被撑开；交给后备的西文衬线
  return [...new Set(text.replace(/[\s‘-‟]/g, ''))].sort().join('') + ' ';
}
