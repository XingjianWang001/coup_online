import { parseServerError } from '@coup/shared';

export const LOCALES = ['zh-CN', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LANGUAGE_OPTIONS: ReadonlyArray<{ locale: Locale; label: string }> = [
  { locale: 'zh-CN', label: '简体中文' },
  { locale: 'en', label: 'English' },
];

const STORAGE_KEY = 'coup.locale';

const english = {
  appTitle: 'Coup',
  settings: 'Settings',
  rules: 'Rules',
  closeRules: 'Close rules',
  leaveRoom: 'Leave room',
  leaveConfirmation: 'Leave the room? Leaving during a game counts as a forfeit.',
  confirmLeave: 'Leave room',
  cancel: 'Cancel',
  settingsTitle: 'Settings',
  language: 'Language',
  closeSettings: 'Close settings',
  rulesTitle: 'Rules',
  quickRules: 'Quick Rules',
  fullRules: 'Full Rules',
  rulesLevel: 'Rules detail',
  rolesTitle: 'Roles',
  nickname: 'Nickname',
  nicknamePlaceholder: 'Your nickname',
  createRoom: 'Create room',
  or: 'or',
  roomCode: 'Room code',
  roomCodeHelp: ' — share this code or the invite link with friends',
  roomCodePlaceholder: '6-character room code',
  joinRoom: 'Join room',
  inviteLink: 'Invite link',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  copy: 'Copy',
  tunnelStarting: 'Starting tunnel…',
  generateInviteLink: 'Generate invite link',
  playersCount: 'Players ({count})',
  hostSuffix: ' (host)',
  offlineSuffix: ' (offline)',
  startGame: 'Start game',
  startGameRequirement: 'Requires at least 2 players',
  leftRoomNotice: 'You left the room.',
  errorRoomNotFound: 'Room not found.',
  errorGameAlreadyStarted: 'The game has already started.',
  errorHostOnly: 'Only the host can start the game.',
  errorMinimumPlayers: 'At least {minimum} players are required to start.',
  errorTunnelUnauthorized: 'Only the host device can start the tunnel.',
  errorTunnelStartup: 'The tunnel could not be started. Check the host connection and try again.',
  errorIllegalIntent: 'That request is not supported.',
  errorInvalidGameAction: 'That action is not allowed right now.',
  errorGameNotStarted: 'The game has not started yet.',
  errorRoomFull: 'This room is full (maximum {maximum} players).',
  errorInvalidName: 'Enter a nickname of 1–32 characters.',
  errorRateLimited: 'Too many rooms created recently. Try again in a minute.',
  errorServerBusy: 'The server is full. Please try again later.',
  errorUnexpected: 'Something went wrong. Please try again.',
  gameStarted: 'Game started!',
  gameEnded: 'Game over',
  playerEliminated: 'A player was eliminated',
  challengeFailed: 'Challenge failed',
  challengeSucceeded: 'Challenge succeeded',
  influenceLostNotice: 'A player lost influence',
  winner: '{name} wins!',
  yourTurn: 'Your turn',
  waitingForAction: 'Waiting for {name} to act…',
  selfMarker: ' (you)',
  coinCount: '{count} coins',
  coinCountOne: '{count} coin',
  influenceCount: '{count} influence',
  chooseTarget: 'Choose a target:',
  mandatoryCoup: 'You have 10 or more coins and must Coup.',
  challenge: 'Challenge!',
  passChallenge: 'Do not challenge',
  blockWith: 'Block with {role}',
  passBlock: 'Do not block',
  chooseInfluenceLoss: 'Choose a hidden card to reveal:',
  revealRole: 'Reveal {role}',
  exchangePrompt: 'Exchange: choose {count} cards to keep',
  confirmKeep: 'Keep selected cards',
  cardBack: 'Hidden card',
  cardFace: '{role} card',
  cardRevealed: '{role} card (revealed)',
  expandLog: 'Expand details for {action}',
  collapseLog: 'Collapse details for {action}',
  narrationAction: '{actor} uses {action}',
  narrationClaim: '{actor} claims {role} to {action}',
  narrationTarget: ', targeting {target}',
  narrationBlock: '; {blocker} blocks with {role}',
  logChallenge: '{challenger} challenges {target}',
  logChallengeFailed: 'Challenge failed: {loser} loses influence',
  logChallengeSucceeded: 'Challenge succeeded: {loser} loses influence',
  logBlock: '{blocker} blocks with {role}',
  logInfluenceLost: '{player} reveals {role}',
  logEliminated: '{player} is eliminated',
  logGameOver: '{winner} wins',
  logCoinsChanged: '{player} coins → {coins}',
  logExchangeDrew: '{player} draws {count} cards',
} as const;

type MessageKey = keyof typeof english;

const simplifiedChinese = {
  appTitle: '政变 Coup',
  settings: '设置',
  rules: '规则',
  closeRules: '关闭规则',
  leaveRoom: '离开房间',
  leaveConfirmation: '确认离开房间？牌局中离开将视为弃权。',
  confirmLeave: '确认离开',
  cancel: '取消',
  settingsTitle: '设置',
  language: '语言',
  closeSettings: '关闭设置',
  rulesTitle: '规则说明',
  quickRules: '简要规则',
  fullRules: '详细规则',
  rulesLevel: '规则详细程度',
  rolesTitle: '角色',
  nickname: '昵称',
  nicknamePlaceholder: '你的昵称',
  createRoom: '创建房间',
  or: '或',
  roomCode: '房间码',
  roomCodeHelp: '（把此码或链接发给朋友）',
  roomCodePlaceholder: '6 位房间码',
  joinRoom: '加入房间',
  inviteLink: '加入链接',
  copied: '已复制',
  copyFailed: '复制失败',
  copy: '复制',
  tunnelStarting: '正在启动隧道…',
  generateInviteLink: '生成加入链接',
  playersCount: '玩家（{count}）',
  hostSuffix: ' (房主)',
  offlineSuffix: ' (离线)',
  startGame: '开始游戏',
  startGameRequirement: '需 ≥2 人',
  leftRoomNotice: '你已离开房间。',
  errorRoomNotFound: '房间不存在。',
  errorGameAlreadyStarted: '牌局已经开始。',
  errorHostOnly: '只有房主可以开始牌局。',
  errorMinimumPlayers: '至少需要 {minimum} 名玩家才能开始。',
  errorTunnelUnauthorized: '只有主机设备可以启动隧道。',
  errorTunnelStartup: '隧道启动失败，请检查主机网络后重试。',
  errorIllegalIntent: '不支持此请求。',
  errorInvalidGameAction: '当前不能执行此行动。',
  errorGameNotStarted: '牌局尚未开始。',
  errorRoomFull: '房间已满（最多 {maximum} 名玩家）。',
  errorInvalidName: '请输入 1～32 个字符的昵称。',
  errorRateLimited: '最近创建的房间过多，请一分钟后再试。',
  errorServerBusy: '服务器房间已满，请稍后再试。',
  errorUnexpected: '出现意外错误，请重试。',
  gameStarted: '牌局开始！',
  gameEnded: '牌局结束',
  playerEliminated: '有玩家被淘汰',
  challengeFailed: '质疑失败',
  challengeSucceeded: '质疑成功',
  influenceLostNotice: '有玩家失去影响力',
  winner: '{name} 获胜！',
  yourTurn: '轮到你了',
  waitingForAction: '等待 {name} 行动…',
  selfMarker: ' (你)',
  coinCount: '{count} 金币',
  coinCountOne: '{count} 金币',
  influenceCount: '{count} 影响力',
  chooseTarget: '选择目标：',
  mandatoryCoup: '你已有 10 枚或更多金币，必须发动政变。',
  challenge: '质疑！',
  passChallenge: '不质疑',
  blockWith: '用{role}阻挡',
  passBlock: '不阻挡',
  chooseInfluenceLoss: '请选择一张暗牌公开翻开：',
  revealRole: '翻开 {role}',
  exchangePrompt: '交换：请选择保留的 {count} 张牌',
  confirmKeep: '确认保留',
  cardBack: '暗牌',
  cardFace: '{role}牌',
  cardRevealed: '{role}牌（已翻开）',
  expandLog: '展开{action}的详情',
  collapseLog: '收起{action}的详情',
  narrationAction: '{actor} 发动{action}',
  narrationClaim: '{actor} 声称【{role}】发动{action}',
  narrationTarget: '，目标 {target}',
  narrationBlock: '；{blocker} 用【{role}】阻挡',
  logChallenge: '{challenger} 质疑 {target}',
  logChallengeFailed: '质疑失败：{loser} 失去影响力',
  logChallengeSucceeded: '质疑成功：{loser} 失去影响力',
  logBlock: '{blocker} 用【{role}】阻挡',
  logInfluenceLost: '{player} 翻开【{role}】',
  logEliminated: '{player} 被淘汰',
  logGameOver: '{winner} 获胜',
  logCoinsChanged: '{player} 金币 → {coins}',
  logExchangeDrew: '{player} 抽取 {count} 张牌',
} as const satisfies Record<MessageKey, string>;

const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': simplifiedChinese,
  en: english,
};

interface MessageValues {
  playersCount: { count: number };
  errorMinimumPlayers: { minimum: number };
  errorRoomFull: { maximum: number };
  winner: { name: string };
  waitingForAction: { name: string };
  coinCount: { count: number };
  coinCountOne: { count: number };
  influenceCount: { count: number };
  blockWith: { role: string };
  revealRole: { role: string };
  exchangePrompt: { count: number };
  cardFace: { role: string };
  cardRevealed: { role: string };
  expandLog: { action: string };
  collapseLog: { action: string };
  narrationAction: { actor: string; action: string };
  narrationClaim: { actor: string; role: string; action: string };
  narrationTarget: { target: string };
  narrationBlock: { blocker: string; role: string };
  logChallenge: { challenger: string; target: string };
  logChallengeFailed: { loser: string };
  logChallengeSucceeded: { loser: string };
  logBlock: { blocker: string; role: string };
  logInfluenceLost: { player: string; role: string };
  logEliminated: { player: string };
  logGameOver: { winner: string };
  logCoinsChanged: { player: string; coins: number };
  logExchangeDrew: { player: string; count: number };
}

type MessageArguments<Key extends MessageKey> = Key extends keyof MessageValues
  ? [values: MessageValues[Key]]
  : [];

function normalizeLocale(value: string | null | undefined): Locale | null {
  const language = value?.trim().replaceAll('_', '-').split('-')[0]?.toLowerCase();
  if (language === 'zh') return 'zh-CN';
  if (language === 'en') return 'en';
  return null;
}

export function detectLocale(preferredLanguages: readonly string[]): Locale {
  for (const preferredLanguage of preferredLanguages) {
    const locale = normalizeLocale(preferredLanguage);
    if (locale) return locale;
  }
  return 'en';
}

export function loadLocale(storage: LocaleStorage | null, preferredLanguages: readonly string[]): Locale {
  try {
    const stored = storage ? normalizeLocale(storage.getItem(STORAGE_KEY)) : null;
    if (stored) return stored;
  } catch {
    // Browsers may deny storage in private or embedded contexts; detection remains usable.
  }
  return detectLocale(preferredLanguages);
}

export function persistLocale(storage: LocaleStorage | null, locale: Locale): void {
  try {
    storage?.setItem(STORAGE_KEY, locale);
  } catch {
    // The active choice still applies for this page when persistence is unavailable.
  }
}

export function translate<Key extends MessageKey>(
  locale: Locale,
  key: Key,
  ...args: MessageArguments<Key>
): string {
  const values = args[0] as Record<string, string | number> | undefined;
  return dictionaries[locale][key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = values?.[name];
    return value === undefined ? placeholder : String(value);
  });
}

export function localizeServerError(locale: Locale, value: unknown): string {
  const error = parseServerError(value);
  switch (error.code) {
    case 'roomNotFound': return translate(locale, 'errorRoomNotFound');
    case 'gameAlreadyStarted': return translate(locale, 'errorGameAlreadyStarted');
    case 'hostOnly': return translate(locale, 'errorHostOnly');
    case 'minimumPlayers': return translate(locale, 'errorMinimumPlayers', error.params);
    case 'tunnelUnauthorized': return translate(locale, 'errorTunnelUnauthorized');
    case 'tunnelStartup': return translate(locale, 'errorTunnelStartup');
    case 'illegalIntent': return translate(locale, 'errorIllegalIntent');
    case 'invalidGameAction': return translate(locale, 'errorInvalidGameAction');
    case 'gameNotStarted': return translate(locale, 'errorGameNotStarted');
    case 'roomFull': return translate(locale, 'errorRoomFull', error.params);
    case 'invalidName': return translate(locale, 'errorInvalidName');
    case 'rateLimited': return translate(locale, 'errorRateLimited');
    case 'serverBusy': return translate(locale, 'errorServerBusy');
    case 'unexpected': return translate(locale, 'errorUnexpected');
  }
}

export type NoticeDescriptor = {
  key: 'gameStarted' | 'gameEnded' | 'playerEliminated' | 'challengeFailed' | 'challengeSucceeded' | 'influenceLostNotice';
};

export function localizeNotice(locale: Locale, notice: NoticeDescriptor): string {
  return translate(locale, notice.key);
}

export function localizeCoinCount(locale: Locale, count: number): string {
  return translate(locale, count === 1 ? 'coinCountOne' : 'coinCount', { count });
}
