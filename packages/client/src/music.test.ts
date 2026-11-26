import { describe, expect, it } from 'vitest';
import type { MessageFlows } from '@coup/shared';
import recorded from '@coup/shared/fixtures/message-flows.json';
import { closeShowdown, initialSession, reduceSession, type Session } from './session.ts';
import { loadMusicSettings, musicStateFor, persistMusicSettings, slideVolume } from './music.ts';
import type { LocaleStorage } from './localization.ts';

// 服务端真实推送的消息序列（见 session.test.ts 开头的说明）
type Flow = keyof MessageFlows;
const flows = recorded as unknown as MessageFlows;

// viewer 从头收到 until 那一步（含）为止的会话。已揭晓的对质舞台在下一步之前播完收起；close 表示最后这一步的也播完了
function sessionAt(flow: Flow, viewer: string, until: string, close = false): Session {
  const steps = flows[flow];
  const end = steps.findIndex((s) => s.step === until);
  if (end < 0) throw new Error(`${flow} 里没有「${until}」这一步`);
  const finish = (s: Session) => (s.showdown?.reveal ? closeShowdown(s) : s);
  const s = steps.slice(0, end + 1).reduce((acc, step) => (step.to[viewer] ?? []).reduce((a, msg) => reduceSession(a, msg, 0), finish(acc)), initialSession);
  return close ? finish(s) : s;
}

describe('背景音乐的状态', () => {
  it('入口页和大厅阶段放大厅的配器，开局后换成牌局', () => {
    expect(musicStateFor(initialSession)).toBe('lobby');
    expect(musicStateFor(sessionAt('duel', 'b', 'b 加入'))).toBe('lobby');
    expect(musicStateFor(sessionAt('duel', 'a', 'a 开局'))).toBe('game');
  });

  it('对质跟着舞台走：翻牌后舞台收起前仍是对质，收起后回到牌局', () => {
    expect(musicStateFor(sessionAt('duel', 'a', 'b 质疑'))).toBe('tension');
    expect(musicStateFor(sessionAt('duel', 'a', 'a 翻开公爵'))).toBe('tension');
    expect(musicStateFor(sessionAt('duel', 'a', 'a 翻开公爵', true))).toBe('game');
  });

  it('只有一方剩 1 点影响力的对质不算生死对质', () => {
    expect(musicStateFor(sessionAt('duel', 'a', 'a 质疑'))).toBe('tension');
  });

  it('双方都只剩 1 点时是生死对质，开场定下，翻牌后有人出局也不变', () => {
    expect(musicStateFor(sessionAt('trio', 'a', 'c 质疑偷窃'))).toBe('sudden_death');
    expect(musicStateFor(sessionAt('trio', 'a', 'b 翻开最后一张，出局'))).toBe('sudden_death');
  });

  it('只剩 1 点影响力按听者自己算', () => {
    expect(musicStateFor(sessionAt('trio', 'c', 'c 失去大使'))).toBe('last_influence');
    expect(musicStateFor(sessionAt('trio', 'b', 'c 失去大使'))).toBe('game');
  });

  it('自己出局后放牌局结束的配器，不再随场上变化；出局那场对质的舞台收起后才换', () => {
    expect(musicStateFor(sessionAt('trio', 'b', 'b 翻开最后一张，出局'))).toBe('sudden_death');
    expect(musicStateFor(sessionAt('trio', 'b', 'b 翻开最后一张，出局', true))).toBe('over');
    expect(musicStateFor(sessionAt('trio', 'a', 'b 翻开最后一张，出局', true))).toBe('game');
  });

  it('暗杀从问询窗口起就紧张，结算完回到牌局', () => {
    expect(musicStateFor(sessionAt('seats', 'a', 'b 暗杀 a'))).toBe('tension');
    expect(musicStateFor(sessionAt('seats', 'a', 'b 翻开队长', true))).toBe('game');
    expect(musicStateFor(sessionAt('seats', 'b', 'b 翻开队长', true))).toBe('last_influence');
  });

  it('旁观一场与自己无关的暗杀只加对质鼓点，暗杀者和目标照常紧张', () => {
    for (const step of ['a 暗杀 b', 'c 不质疑暗杀', 'b 不阻挡暗杀']) {
      expect(musicStateFor(sessionAt('bystander', 'c', step))).toBe('last_influence');
      expect(musicStateFor(sessionAt('bystander', 'a', step))).toBe('tension');
      expect(musicStateFor(sessionAt('bystander', 'b', step))).toBe('tension');
    }
    expect(musicStateFor(sessionAt('bystander', 'c', 'b 失去公爵'))).toBe('game');
  });

  it('牌局结束：决胜那场对质的舞台收起后，赢家换成胜利曲，输家换成结束的配器', () => {
    expect(musicStateFor(sessionAt('duel', 'a', 'b 翻开女伯爵，出局'))).toBe('tension');
    expect(musicStateFor(sessionAt('duel', 'a', 'b 翻开女伯爵，出局', true))).toBe('victory');
    expect(musicStateFor(sessionAt('duel', 'b', 'b 翻开女伯爵，出局', true))).toBe('over');
  });
});

function memoryStorage(): LocaleStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

describe('背景音乐的音量', () => {
  it('默认开着、音量 50；存储被禁用时也一样', () => {
    const denied: LocaleStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadMusicSettings(memoryStorage())).toEqual({ volume: 50, muted: false });
    expect(loadMusicSettings(denied)).toEqual({ volume: 50, muted: false });
    expect(() => persistMusicSettings(denied, { volume: 20, muted: true })).not.toThrow();
  });

  it('分开记住音量和静音，不认得的音量回到默认', () => {
    const storage = memoryStorage();
    persistMusicSettings(storage, { volume: 20, muted: true });
    expect(loadMusicSettings(storage)).toEqual({ volume: 20, muted: true });
    storage.setItem('coup.musicVolume', '0');
    expect(loadMusicSettings(storage).volume).toBe(50);
  });

  it('拖到 0 记作静音，留着拖动前的音量', () => {
    expect(slideVolume(60, 0)).toEqual({ volume: 60, muted: true });
    expect(slideVolume(60, 30)).toEqual({ volume: 30, muted: false });
  });
});
