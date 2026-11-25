/// <reference types="vite/client" />
import type { LocaleStorage } from './localization.ts';
import type { Session } from './session.ts';
import manifest from './music/manifest.json';

// 背景音乐（CONTEXT.md）。./music/ 整个由 game-music-studio 的 `render.py game` 导出：各状态的增益与优先级以那里的 manifest 为准，这里不另抄。
// 所有分轨从同一时刻起同步循环，换状态只调各分轨的增益。
export type MusicState = keyof typeof manifest.states;
type Track = keyof typeof manifest.files;

const STATES = manifest.states as Record<MusicState, Partial<Record<Track, number>>>;
const TRACKS = Object.keys(manifest.files) as Track[];
// 自成一曲的分轨（manifest 的 loops 里有自己的循环长度，现在只有胜利曲）：不和其余分轨一起从 origin 循环。
// 进出都不等，从下一拍起，拍子仍和主循环对齐：
// - 进：它在那一拍从第 1 小节（crash）整个进来，其余分轨 1 s 退场，D 小调不在 D 大调底下多拖
// - 出：主循环在那一拍从第 1 小节重新起（萨克斯长音 A，两个调都有这个音），照常 1 s 进场，它照常 2 s 退场
const OWN_LOOPS: Partial<Record<Track, number>> = manifest.loops;
const ownPiece = (t: Track) => t in OWN_LOOPS;
// 放在 src/ 下由 Vite 打进带哈希的 assets/，服务端对 assets/ 长期缓存
const URLS = import.meta.glob<string>('./music/*.mp3', { eager: true, query: '?url', import: 'default' });
// 换一套音色时互相交接的分轨：交出的一方和进来的一方一样快，免得两套叠在一起发闷
const SWAPS: Track[][] = [['band_a', 'band_b'], ['trem_synth', 'trem_vpo']];
const RISE_SECONDS = 1;
const FALL_SECONDS = 2;

// 几种状态同时成立时按 manifest 的 priority 取第一个。对质跟着对质舞台走：翻牌动画播完舞台收起前，音乐不先退回去
export function musicStateFor(s: Session): MusicState {
  const state = s.publicState;
  const me = state?.players.find((p) => p.id === s.playerId);
  // 自己出局后放牌局结束的配器，不再随场上变化；出局那场对质的舞台收起后才换
  if (me && !me.alive && !s.showdown) return 'over';
  const playing = !!state && state.phase !== 'gameOver';
  // 暗杀从问询窗口起到结算完（pending 清空）；政变不算
  const assassination = playing && state.pending?.action === 'assassinate' ? state.pending : null;
  const involved = !!assassination && (assassination.actorId === s.playerId || assassination.targetId === s.playerId);
  const holds: Record<MusicState, boolean> = {
    sudden_death: !!s.showdown?.suddenDeath,
    tension: !!s.showdown || involved,
    // 这套配器（牌局 + 对质鼓点）用在自己只剩 1 点影响力时，也用在旁观一场与自己无关的暗杀时
    last_influence: playing && ((!!me?.alive && me.handCount === 1) || !!assassination),
    game: playing,
    lobby: !state, // 入口页和大厅阶段
    victory: state?.phase === 'gameOver' && state.winnerId === s.playerId, // 只有赢家听胜利曲
    over: true,
  };
  return (manifest.priority as MusicState[]).find((k) => holds[k]) ?? 'over';
}

// 音量与静音分开存：拖到 0 只记作静音，不覆盖之前的音量，取消静音时回到原来的音量
export interface MusicSettings {
  volume: number; // 1–100
  muted: boolean;
}

const VOLUME_KEY = 'coup.musicVolume';
const MUTED_KEY = 'coup.musicMuted';
const DEFAULT_SETTINGS: MusicSettings = { volume: 50, muted: false };

export function loadMusicSettings(storage: LocaleStorage | null): MusicSettings {
  try {
    const volume = Number(storage?.getItem(VOLUME_KEY));
    return {
      volume: Number.isInteger(volume) && volume >= 1 && volume <= 100 ? volume : DEFAULT_SETTINGS.volume,
      muted: storage?.getItem(MUTED_KEY) === '1',
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function persistMusicSettings(storage: LocaleStorage | null, settings: MusicSettings): void {
  try {
    storage?.setItem(VOLUME_KEY, String(settings.volume));
    storage?.setItem(MUTED_KEY, settings.muted ? '1' : '0');
  } catch {
    // 存不进就只在这个页面生效
  }
}

// 滑块拖到 value；startVolume 是这次拖动（或聚焦）开始时的音量，拖到 0 时留着它
export function slideVolume(startVolume: number, value: number): MusicSettings {
  return value === 0 ? { volume: startVolume, muted: true } : { volume: value, muted: false };
}

export interface Music {
  setState(state: MusicState): void;
  setSettings(settings: MusicSettings): void;
}

// 浏览器要等用户第一次操作页面才允许出声：在此之前 AudioContext 停在 suspended，分轨照常载入、排好，第一次点按时一起响起
export function createMusic(): Music {
  let ctx: AudioContext | null = null;
  let output: GainNode;
  let presence: GainNode;
  let origin = 0;
  const gains = {} as Record<Track, GainNode>;
  const buffers: Partial<Record<Track, AudioBuffer>> = {};
  let wanted: MusicState = 'lobby';
  let current: MusicState | null = null; // 增益已经排到的状态
  let settings = DEFAULT_SETTINGS;
  let loading = false;

  function context(): AudioContext {
    if (ctx) return ctx;
    ctx = new AudioContext();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.ratio.value = 3;
    output = ctx.createGain();
    presence = ctx.createGain();
    compressor.connect(output).connect(presence).connect(ctx.destination);
    for (const track of TRACKS) {
      gains[track] = ctx.createGain();
      gains[track].gain.value = 0;
      gains[track].connect(compressor);
    }
    origin = ctx.currentTime;
    output.gain.value = level();
    return ctx;
  }

  // 平方曲线：听感上每一格的变化差不多大
  const level = () => (settings.muted ? 0 : (settings.volume / 100) ** 2);

  // 先载入入口和大厅要用的分轨，其余在后台载入；本机静音时一条都不下，取消静音后才开始
  async function load() {
    if (loading) return;
    loading = true;
    const first = Object.keys(STATES.lobby) as Track[];
    await Promise.all(first.map(fetchTrack));
    await Promise.all(TRACKS.filter((t) => !first.includes(t)).map(fetchTrack));
  }

  async function fetchTrack(track: Track) {
    try {
      const response = await fetch(URLS[`./music/${manifest.files[track]}`], { priority: 'low' });
      if (!response.ok) return;
      const buffer = await context().decodeAudioData(await response.arrayBuffer());
      buffers[track] = buffer;
      if (!ownPiece(track)) play(track);
      apply();
    } catch {
      // 这一条放不了：需要它的状态维持之前的配器，其余照常
    }
  }

  // 每个文件首尾多带了 loop_start_seconds 的循环内容，从那里起循环，解码器留下的补零碰不到接缝。
  // 同步循环的分轨在 when 放到 origin 起算的位置（origin 可以在 when 之后：主循环重新起头前载入的，正好在那时转回第 1 小节）；
  // 自成一曲的从头放。替下这一条之前的声源
  const sources: Partial<Record<Track, AudioBufferSourceNode>> = {};
  function play(track: Track, at?: number) {
    const c = context();
    const source = c.createBufferSource();
    source.buffer = buffers[track]!;
    const loop = OWN_LOOPS[track] ?? manifest.loop_seconds;
    source.loop = true;
    source.loopStart = manifest.loop_start_seconds;
    source.loopEnd = manifest.loop_start_seconds + loop;
    source.connect(gains[track]);
    const when = at ?? c.currentTime + 0.05;
    const position = ownPiece(track) ? 0 : (((when - origin) % loop) + loop) % loop;
    source.start(when, manifest.loop_start_seconds + position);
    sources[track]?.stop(when);
    sources[track] = source;
  }

  // 从下一拍起换配器：进场 1 s，退场 2 s。目标状态有分轨还没到时先维持当前配器，到了再换
  // 进出胜利曲见 OWN_LOOPS
  function apply() {
    if (!ctx || wanted === current) return;
    const to = STATES[wanted];
    if ((Object.keys(to) as Track[]).some((t) => !buffers[t])) return;
    const from = current ? STATES[current] : {};
    const now = ctx.currentTime;
    const beat = manifest.beat_seconds;
    const rising = new Set(TRACKS.filter((t) => (to[t] ?? 0) > (from[t] ?? 0)));
    const changed = TRACKS.filter((t) => (from[t] ?? 0) !== (to[t] ?? 0));
    const leaving = current ? changed.find((t) => ownPiece(t) && !to[t]) : undefined;
    const entering = !leaving && changed.some(ownPiece);
    const at = current ? origin + Math.ceil((now + 0.02 - origin) / beat) * beat : now;
    if (leaving) {
      origin = at; // 主循环从这一拍重新数起：全部同步分轨在 at 回到第 1 小节
      for (const track of TRACKS) if (!ownPiece(track) && buffers[track]) play(track, at);
      sources[leaving]?.stop(at + FALL_SECONDS);
    }
    for (const track of changed) {
      const [a, b] = [from[track] ?? 0, to[track] ?? 0];
      const g = gains[track].gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      if (ownPiece(track) && b > a) {
        play(track, at); // 从第 1 小节的强拍整个进来
        g.setValueAtTime(0, at);
        g.linearRampToValueAtTime(b, at + 0.02);
      } else {
        const handsOver = entering || SWAPS.some((pair) => pair.includes(track) && pair.some((t) => t !== track && rising.has(t)));
        g.setValueAtTime(g.value, at);
        g.linearRampToValueAtTime(b, at + (b > a || handsOver ? RISE_SECONDS : FALL_SECONDS));
      }
    }
    current = wanted;
  }

  // 调音量时 50 ms 内跟上，拖得再快也没有咔嗒声
  function applySettings() {
    if (!ctx) return;
    output.gain.cancelScheduledValues(ctx.currentTime);
    output.gain.setTargetAtTime(level(), ctx.currentTime, 0.015);
  }

  // 用户激活只认这几种事件（触屏上 pointerdown 不算，pointerup 才算）；一直听着，iOS 打断后也能在下一次点按时恢复
  // 静音时也建好 AudioContext：点「取消静音」的这一下就能放行，不用再点一次
  const unlock = () => {
    if (document.hidden) return;
    const c = context();
    if (c.state !== 'running') void c.resume();
  };
  for (const type of ['pointerdown', 'pointerup', 'keydown']) document.addEventListener(type, unlock, true);

  // 切到后台：0.3 s 淡出后暂停；切回来从暂停处接着放，0.5 s 淡入
  document.addEventListener('visibilitychange', () => {
    if (!ctx || ctx.state === 'closed') return;
    const c = ctx;
    const g = presence.gain;
    g.cancelScheduledValues(c.currentTime);
    g.setValueAtTime(g.value, c.currentTime);
    if (document.hidden) {
      g.linearRampToValueAtTime(0, c.currentTime + 0.3);
      setTimeout(() => document.hidden && void c.suspend(), 350);
    } else {
      void c.resume().then(() => {
        g.cancelScheduledValues(c.currentTime);
        g.setValueAtTime(0, c.currentTime);
        g.linearRampToValueAtTime(1, c.currentTime + 0.5);
      });
    }
  });

  return {
    setState(state) {
      wanted = state;
      apply();
    },
    setSettings(next) {
      settings = next;
      applySettings();
      if (!next.muted) void load();
    },
  };
}
