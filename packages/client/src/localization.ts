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
  leftRoomReason: 'You left: {reason}',
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
  errorUnexpected: 'Something went wrong. Please try again.',
} as const;

type MessageKey = keyof typeof english;

const simplifiedChinese = {
  appTitle: '政变 Coup',
  settings: '设置',
  rules: '规则',
  closeRules: '关闭规则',
  leaveRoom: '离开房间',
  leaveConfirmation: '确认离开房间？对局中离开将视为弃权。',
  confirmLeave: '确认离开',
  cancel: '取消',
  settingsTitle: '设置',
  language: '语言',
  closeSettings: '关闭设置',
  rulesTitle: '规则说明',
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
  leftRoomReason: '你已离开：{reason}',
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
  errorUnexpected: '出现意外错误，请重试。',
} as const satisfies Record<MessageKey, string>;

const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': simplifiedChinese,
  en: english,
};

interface MessageValues {
  playersCount: { count: number };
  leftRoomReason: { reason: string };
  errorMinimumPlayers: { minimum: number };
  errorRoomFull: { maximum: number };
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
    case 'unexpected': return translate(locale, 'errorUnexpected');
  }
}
