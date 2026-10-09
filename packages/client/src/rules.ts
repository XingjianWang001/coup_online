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
    captain: '偷窃：从一名玩家处偷取至多 2 金币；可阻挡偷窃。', ambassador: '交换：从牌堆抽 2 张，再将 2 张洗回牌堆；可阻挡偷窃。', contessa: '反暗杀：可阻挡暗杀。',
  },
  en: {
    duke: 'Tax: take 3 coins; may block Foreign Aid.', assassin: 'Assassinate: pay 3 coins to make a player lose 1 influence.',
    captain: 'Steal: take up to 2 coins from a player; may block Steal.', ambassador: 'Exchange: draw 2 cards, then shuffle 2 back; may block Steal.', contessa: 'May block Assassinate.',
  },
};

export type RuleLevel = 'quick' | 'full';

export interface RuleSection {
  id: string;
  title: string;
  body: string;
  items?: readonly string[];
  roleReferenceBefore?: boolean;
  onlineOnly?: boolean;
}

const RULES: Record<Locale, Record<RuleLevel, readonly RuleSection[]>> = {
  'zh-CN': {
    quick: [
      { id: 'objective', title: '目标', body: '成为最后仍有影响力的玩家。' },
      { id: 'influence-and-turns', title: '影响力与回合', body: '你以 2 张暗牌开始；每张暗牌代表 1 影响力。每回合必须选择一个行动，不能跳过。失去影响力时，自选一张暗牌公开翻开；没有暗牌即被淘汰。' },
      {
        id: 'actions',
        title: '七种行动',
        body: '不必真的持有角色也可声称角色行动，但可能被质疑。',
        roleReferenceBefore: true,
        items: [
          '收入：获得 1 金币；不能被质疑或阻挡。',
          '外援：获得 2 金币；不能被质疑，但任何对手都可声称公爵阻挡。',
          '政变：支付 7 金币，令一名对手失去 1 影响力；不能被质疑或阻挡。',
          '征税：声称公爵，获得 3 金币。',
          '暗杀：支付 3 金币并声称刺客，令目标失去 1 影响力；目标可声称女伯爵阻挡。',
          '偷窃：声称队长，从目标处拿取至多 2 金币；目标可声称队长或大使阻挡。',
          '交换：声称大使，从牌堆抽 2 张，再把多余的牌洗回牌堆，保留原有数量的暗牌。',
        ],
      },
      { id: 'claims', title: '声称', body: '征税、暗杀、偷窃、交换与所有阻挡都包含角色声称。声称可以属实，也可以虚张声势。' },
      { id: 'challenges', title: '质疑', body: '任何其他存活玩家都可质疑角色声称。声称属实：质疑者失去 1 影响力，声称者把出示的牌洗回牌堆并抽取替代牌；声称不实：声称者失去 1 影响力，行动或阻挡失败。' },
      { id: 'blocks', title: '阻挡', body: '公爵阻挡外援；女伯爵阻挡对自己的暗杀；队长或大使阻挡对自己的偷窃。阻挡也是可被质疑的声称。' },
      { id: 'mandatory-coup', title: '十金币规则', body: '回合开始时若有 10 枚或更多金币，该回合必须发动政变。' },
      { id: 'online-play', title: '线上牌局', body: '行动与问询窗口有倒计时；超时会自动选择行动或放弃回应。短暂断线可凭本机身份重连，超过宽限时间或主动离开牌局会弃权。', onlineOnly: true },
    ],
    full: [
      { id: 'setup', title: '准备', body: '五种角色各有 3 张牌。洗牌后每人获得 2 张暗牌和 2 枚金币，其余牌组成牌堆。确定一名起始玩家；标准两人局中，起始玩家以 1 枚金币开局，另一位玩家仍以 2 枚金币开局。' },
      { id: 'influence', title: '影响力', body: '你的暗牌就是影响力。除非规则要求，不得向他人展示。每次失去影响力时，自选一张暗牌公开翻开；明牌始终可见且不再提供影响力。没有暗牌时立即被淘汰，最后仍有影响力的玩家获胜。' },
      { id: 'turn-flow', title: '回合流程', body: '玩家依次行动。当前玩家必须选择一个负担得起的行动，不能跳过。宣布行动后，先处理角色声称的质疑，再处理可能的阻挡及其质疑；未被成功质疑或阻挡的行动随后结算。' },
      {
        id: 'general-actions',
        title: '通用行动',
        body: '这些行动不需要声称角色。',
        roleReferenceBefore: true,
        items: [
          '收入：获得 1 金币；不能被质疑或阻挡。',
          '外援：获得 2 金币；不能被质疑，但任何对手都可声称公爵阻挡。',
          '政变：支付 7 金币，令一名对手失去 1 影响力；必定成功，不能被质疑或阻挡。',
        ],
      },
      {
        id: 'role-actions',
        title: '角色行动',
        body: '使用时声称相应角色；无需预先展示暗牌。',
        items: [
          '公爵 — 征税：获得 3 金币。',
          '刺客 — 暗杀：支付 3 金币，令目标失去 1 影响力。',
          '队长 — 偷窃：从目标处拿取至多 2 金币。',
          '大使 — 交换：从牌堆抽 2 张，与自己的暗牌一起选择保留原有数量，再将其余牌洗回牌堆。',
          '女伯爵没有角色行动。',
        ],
      },
      { id: 'blocks', title: '阻挡', body: '阻挡会抵消行动，但本身是角色声称。任何对手可用公爵阻挡外援；只有目标可用女伯爵阻挡暗杀，或用队长／大使阻挡偷窃。收入、政变、征税和交换不能被阻挡。' },
      { id: 'challenges', title: '质疑', body: '任何其他存活玩家都可质疑行动或阻挡中的角色声称。机会只存在于声称刚宣布后；继续流程后不能追溯质疑。质疑失败的一方立即失去 1 影响力。' },
      { id: 'truthful-claim', title: '属实的声称', body: '若被质疑者持有相应角色，则出示该牌，把它放回牌堆并洗牌，再抽取一张替代牌。质疑者失去 1 影响力，之后原行动或阻挡继续结算。' },
      { id: 'successful-challenge', title: '成功的质疑', body: '若被质疑者无法或不愿出示相应角色，其失去 1 影响力。被成功质疑的行动或阻挡失败；若该行动已支付费用，费用退还。对不实暗杀声称的成功质疑会退还 3 枚金币。' },
      { id: 'assassination-danger', title: '暗杀的双重风险', body: '暗杀目标若错误质疑了真实的刺客，会先因质疑失败失去 1 影响力，再因暗杀结算失去 1 影响力。若以不实的女伯爵阻挡并被成功质疑，也会先失去 1 影响力，再承受暗杀。一次回合可能因此失去两点影响力。' },
      { id: 'negotiation', title: '交涉', body: '玩家可以讨论、承诺或结盟，但任何协议都没有约束力。不得向其他玩家展示暗牌，也不得赠送或借出金币。' },
      { id: 'mandatory-coup', title: '十金币规则', body: '回合开始时若有 10 枚或更多金币，只能发动政变。' },
      {
        id: 'online-play',
        title: '线上牌局规则',
        body: '以下是本线上版本的流程，不属于桌游基础规则。',
        onlineOnly: true,
        items: [
          '每局由系统随机选择起始玩家。',
          '行动阶段限时 60 秒；超时自动选择收入。若玩家已有至少 10 枚金币，则自动对随机合法目标发动政变。',
          '问询窗口限时 20 秒；无论当前等待质疑还是阻挡，超时都视为所有尚未回应的玩家放弃。',
          '刷新或短暂断线后，本机可凭保存的临时身份回到原座位。断线宽限为 90 秒。',
          '宽限期内未重连会自动弃权；牌局中主动离开也会立即弃权。弃权会公开全部剩余暗牌并淘汰该玩家。',
        ],
      },
    ],
  },
  en: {
    quick: [
      { id: 'objective', title: 'Objective', body: 'Be the last player who still has influence.' },
      { id: 'influence-and-turns', title: 'Influence and turns', body: 'You begin with 2 Hidden Cards—the face-down character cards of the tabletop rulebook. Each is 1 Influence. You must choose one Action on every turn and may not pass. When you lose Influence, choose a Hidden Card to reveal. With none left, you are eliminated.' },
      {
        id: 'actions',
        title: 'Seven actions',
        body: 'You may claim a Role Action (called a character action in the tabletop rulebook) without holding that Role, but another player may Challenge you.',
        roleReferenceBefore: true,
        items: [
          'Income: take 1 coin; it cannot be Challenged or Blocked.',
          'Foreign Aid: take 2 coins; it cannot be Challenged, but any opponent may claim Duke to Block it.',
          'Coup: pay 7 coins; the target loses 1 influence. It cannot be Challenged or Blocked.',
          'Tax: claim Duke and take 3 coins.',
          'Assassinate: pay 3 coins and claim Assassin; the target loses 1 influence. The target may claim Contessa to Block.',
          'Steal: claim Captain and take up to 2 coins from the target. The target may claim Captain or Ambassador to Block.',
          'Exchange: claim Ambassador, draw 2 cards, then shuffle cards back into the Deck (Court deck) until you have your original number of Hidden Cards.',
        ],
      },
      { id: 'claims', title: 'Claims', body: 'Tax, Assassinate, Steal, Exchange, and every Block include a Role Claim. A Claim may be truthful or a bluff.' },
      { id: 'challenges', title: 'Challenges', body: 'Any other living player may Challenge a Role Claim. If it is true, the challenger loses 1 Influence and the claimant shuffles the shown card into the Deck before drawing a replacement. If it is false, the claimant loses 1 Influence and the Action or Block fails.' },
      { id: 'blocks', title: 'Blocks', body: 'Duke Blocks Foreign Aid; Contessa Blocks an Assassination against herself; Captain or Ambassador Blocks a Steal against themselves. A Block is a Claim and may be Challenged.' },
      { id: 'mandatory-coup', title: 'The ten-coin rule', body: 'If you start your turn with 10 or more coins, you must Coup that turn.' },
      { id: 'online-play', title: 'Online play', body: 'Actions and Interrogation Windows use timers; a timeout automatically chooses an Action or passes. A short disconnect can reconnect with the identity stored on that device. Leaving a Game or exceeding the grace period causes a Forfeit.', onlineOnly: true },
    ],
    full: [
      { id: 'setup', title: 'Setup', body: 'The Deck (Court deck) has 3 copies of each of the five Roles (characters). Shuffle it, deal 2 Hidden Cards (face-down character cards) and 2 coins to every player, and leave the rest as the Deck. Choose a starting player. In the standard two-player game, the starting player begins with 1 coin while the other player still begins with 2.' },
      { id: 'influence', title: 'Influence', body: 'Your Hidden Cards are your Influence. Do not show them unless a rule tells you to. Whenever you lose Influence, choose one to reveal; Revealed Cards stay visible and no longer count as Influence. You are eliminated when none remain. The last Player with Influence wins.' },
      { id: 'turn-flow', title: 'Turn flow', body: 'Players take turns in order. The current player must choose one action they can afford and may not pass. After an action is declared, resolve any Challenge to its Claim first, then any Block and Challenge to that Block. An action that survives these responses resolves.' },
      {
        id: 'general-actions',
        title: 'General actions',
        body: 'These Actions do not Claim a Role.',
        roleReferenceBefore: true,
        items: [
          'Income: take 1 coin; it cannot be Challenged or Blocked.',
          'Foreign Aid: take 2 coins; it cannot be Challenged, but any opponent may claim Duke to Block it.',
          'Coup: pay 7 coins and make one opponent lose 1 Influence. It always succeeds and cannot be Challenged or Blocked.',
        ],
      },
      {
        id: 'role-actions',
        title: 'Role Actions (Character Actions)',
        body: 'Claim the named Role when using one; you do not show a Hidden Card unless Challenged.',
        items: [
          'Duke — Tax: take 3 coins.',
          'Assassin — Assassinate: pay 3 coins; the target loses 1 influence.',
          'Captain — Steal: take up to 2 coins from the target.',
          'Ambassador — Exchange: draw 2 cards, choose your original number of Hidden Cards to keep, and shuffle the rest into the Deck.',
          'Contessa has no Role Action.',
        ],
      },
      { id: 'blocks', title: 'Blocks (Counteractions)', body: 'A Block cancels an Action but is itself a Role Claim. Any opponent may claim Duke to Block Foreign Aid. Only the target may claim Contessa against Assassinate, or Captain or Ambassador against Steal. Income, Coup, Tax, and Exchange cannot be Blocked.' },
      { id: 'challenges', title: 'Challenges', body: 'Any other living Player may Challenge the Role Claim in an Action or Block. The opportunity exists immediately after the Claim; once play continues, it cannot be Challenged retroactively. Whoever loses the Challenge immediately loses 1 Influence.' },
      { id: 'truthful-claim', title: 'A truthful Claim', body: 'If the challenged Player has the named Role, they show it, return it to the Deck, shuffle, and draw a replacement. The challenger loses 1 Influence, then the original Action or Block continues.' },
      { id: 'successful-challenge', title: 'A successful Challenge', body: 'If the challenged Player cannot or will not show the named Role, they lose 1 Influence. Their Action or Block fails. Any cost already paid for the failed Action is refunded; successfully Challenging a false Assassin Claim returns its 3 coins.' },
      { id: 'assassination-danger', title: 'Assassination’s double danger', body: 'A target who incorrectly Challenges a truthful Assassin loses 1 influence for the Challenge and another when the Assassination resolves. A false Contessa Block that is successfully Challenged has the same sequence. One turn can therefore cost both influence.' },
      { id: 'negotiation', title: 'Negotiation', body: 'Players may discuss, promise, and form alliances, but no deal is binding. You may not reveal Hidden Cards to another Player, and coins may not be given or lent.' },
      { id: 'mandatory-coup', title: 'The ten-coin rule', body: 'If you start a turn with 10 or more coins, Coup is your only legal action.' },
      {
        id: 'online-play',
        title: 'Online-play rules',
        body: 'These are procedures of this online version, not rules of the tabletop base game.',
        onlineOnly: true,
        items: [
          'The system chooses a starting player at random for each game.',
          'The action phase lasts 60 seconds. A timeout chooses Income automatically, or a Coup against a random legal target when the player has at least 10 coins.',
          'An Interrogation Window lasts 20 seconds. Whether it is waiting for a Challenge or a Block, a timeout passes for everyone who has not responded.',
          'After a refresh or brief disconnect, the device can use its saved temporary identity to reclaim the same seat. The disconnect grace period is 90 seconds.',
          'Failing to reconnect within the grace period causes an automatic Forfeit. Leaving during a Game Forfeits immediately. A Forfeit reveals all remaining Hidden Cards and eliminates that Player.',
        ],
      },
    ],
  },
};

export const roleName = (locale: Locale, role: Role): string => ROLE_NAMES[locale][role];
export const actionName = (locale: Locale, action: ActionType): string => ACTION_NAMES[locale][action];
// 大牌放不下全名时的缩写；中文名都放得下，不需要
const ROLE_SHORT_NAMES: Partial<Record<Locale, Partial<Record<Role, string>>>> = {
  en: { assassin: 'Assn.', captain: 'Capt.', ambassador: 'Amb.', contessa: 'Ctss.' },
};

export const roleShortName = (locale: Locale, role: Role): string | undefined => ROLE_SHORT_NAMES[locale]?.[role];

// 规则中心图标对照里的银元一行：座位上只显示图标与数字
const COIN_LEGEND: Record<Locale, { name: string; description: string }> = {
  'zh-CN': { name: '金币', description: '座位上银元旁的数字即该玩家持有的金币数。' },
  en: { name: 'Coins', description: 'The number beside the coin on each seat is how many coins that player holds.' },
};

export const coinLegend = (locale: Locale) => COIN_LEGEND[locale];
export const roleDescription = (locale: Locale, role: Role): string => ROLE_DESCRIPTIONS[locale][role];
export const rulesFor = (locale: Locale, level: RuleLevel = 'quick'): readonly RuleSection[] => RULES[locale][level];
