import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { parseServerError, type ActionType, type ServerError } from '@coup/shared';
import { clearIdentity, clearRoomCode, connect, loadIdentity, loadRoomCode, onMessage, saveIdentity, saveRoomCode, send, type ServerMessage } from './socket.ts';
import { estimateServerOffset } from './narration.ts';
import { scheduleAutoDismiss } from './transient.ts';
import { closeShowdown, dropMotion, initialSession, reduceSession, rejoinIntent, type Session } from './session.ts';
import { loadCardStyle, persistCardStyle, preloadCardStyle, type CardStyle } from './cardStyle.ts';
import { createMusic, loadMusicSettings, musicStateFor, persistMusicSettings, type MusicSettings } from './music.ts';
import { loadLocale, localizeServerError, persistLocale, translate, type Locale, type NoticeDescriptor } from './localization.ts';
import type { Clock } from './clock.tsx';
import { DealShowcase } from './DealShowcase.tsx';
import { EntryForm, FilingFooter, normalizeRoomCode, type Filing } from './Entry.tsx';
import { LeaveConfirmation, RulesPanel, SettingsPanel } from './panels.tsx';
import { RoomView, TransientMessage, type LatestReaction, type ReactionBubble, type TransientNoticeState } from './RoomView.tsx';
import { ExchangeStage, LossStage, ShowdownStage } from './ShowdownStage.tsx';

const REACTION_MS = 3000; // 与 style.css 里 .nameplate-text 的淡出时刻对齐
const NOTICE_GAP_MS = 300;

interface TransientErrorState {
  id: number;
  // 离开房间/座位被接管不是服务器错误，但与错误共用同一条红色提示。
  error: ServerError | { notice: 'leftRoomNotice' | 'replacedRoomNotice' };
}

type SessionAction = { msg: ServerMessage; now: number } | { patch: Partial<Session> } | { closeShowdown: true } | { dropMotion: number };

function sessionReducer(s: Session, a: SessionAction): Session {
  if ('closeShowdown' in a) return closeShowdown(s);
  if ('dropMotion' in a) return dropMotion(s, a.dropMotion);
  return 'msg' in a ? reduceSession(s, a.msg, a.now) : { ...s, ...a.patch };
}

// 加入链接的 ?room= 参数：仅首次加载读取一次，读后从 URL 清除，避免刷新时重复触发。
const LINK_ROOM = (() => {
  const params = new URLSearchParams(window.location.search);
  const room = normalizeRoomCode(params.get('room') ?? '') || null;
  if (room) {
    params.delete('room');
    const qs = params.toString();
    const clean = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, '', clean);
  }
  return room;
})();
// 加入任意房间后链接已用完，之后断线重连按本地保存的房间码自动回到原座位。
let pendingLinkRoom = LINK_ROOM;
// 座位被其他标签页接管后，本标签页断线重连不再自动加入，直到用户在这里重新进房。
let replaced = false;
// 整个页面一份背景音乐；放在模块里，开发模式下 StrictMode 重复挂载也不会建出第二份
const music = createMusic();

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function useAutoDismiss<T extends { id: number }>(
  value: T | null,
  setValue: (update: (current: T | null) => T | null) => void,
) {
  useEffect(() => {
    if (!value) return;
    return scheduleAutoDismiss(value, setValue);
  }, [setValue, value]);
}

export function App() {
  const socket = useMemo(() => connect(), []);
  const [locale, setLocale] = useState<Locale>(() =>
    loadLocale(browserStorage(), navigator.languages.length ? navigator.languages : [navigator.language]),
  );
  const [identity, setIdentity] = useState(() => loadIdentity());
  // 每次（重新）进房加一：离线时点下的选择被 send 丢弃了，选择对话框要重新挂载，不能还锁在「已发送」
  const [joinCount, setJoinCount] = useState(0);
  const [name, setName] = useState(() => identity?.name ?? '');
  const nameRef = useRef(name);
  nameRef.current = name;
  const [roomCode, setRoomCode] = useState(() => LINK_ROOM ?? loadRoomCode() ?? '');
  const [session, dispatchSession] = useReducer(sessionReducer, initialSession);
  const {
    roomCode: joined,
    hostId,
    players,
    publicState,
    hand,
    log,
    countdown: countdownSnapshot,
    tunnelUrl,
    canStartTunnel,
    tunnelLoading,
    selectedAction,
    showcase,
    showdown,
    motions,
  } = session;
  const setSelectedAction = useCallback((a: ActionType | null) => dispatchSession({ patch: { selectedAction: a } }), []);
  const [error, setError] = useState<TransientErrorState | null>(null);
  const errorIdRef = useRef(0);
  const [notice, setNotice] = useState<TransientNoticeState | null>(null);
  const [noticeQueue, setNoticeQueue] = useState<TransientNoticeState[]>([]);
  const noticeIdRef = useRef(0);
  const [reactions, setReactions] = useState<Record<string, ReactionBubble>>({});
  const [latestReaction, setLatestReaction] = useState<LatestReaction | null>(null);
  const reactionIdRef = useRef(0);
  const reactionTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // id 缺省：不管是哪一条都收起（玩家点掉）；给了 id：只在仍是这一条时收起（到时自动消失，不误删新顶上来的）
  const dropReaction = useCallback((playerId: string, id?: number) => {
    setReactions((current) => {
      if (!current[playerId] || (id !== undefined && current[playerId].id !== id)) return current;
      const next = { ...current };
      delete next[playerId];
      return next;
    });
  }, []);
  const [showRules, setShowRules] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [serverOffsetMs, setServerOffsetMs] = useState<number | null>(null);
  const closeRules = useCallback(() => setShowRules(false), []);
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const closeLeaveConfirmation = useCallback(() => setConfirmLeave(false), []);
  const closeShowcase = useCallback(() => dispatchSession({ patch: { showcase: null } }), []);
  const finishShowdown = useCallback(() => dispatchSession({ closeShowdown: true }), []);
  const finishMotion = useCallback((id: number) => dispatchSession({ dropMotion: id }), []);

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    persistLocale(browserStorage(), nextLocale);
  }

  // 按域名的站点设置不进公开仓库，由服务端给出（见 server/src/credits.ts）。取不到就当这个域名什么都没开。
  const [site, setSite] = useState<{ filing?: Filing; cardStyles?: boolean }>({});
  useEffect(() => {
    fetch('/api/site').then((response) => (response.ok ? response.json() : {})).then(setSite, () => {});
  }, []);

  // 只有开放了牌面风格的域名，设置里才出现这一项；其他域名大牌一律按默认风格显示，选过的风格留着下次用。
  const [cardStyle, setCardStyle] = useState(() => loadCardStyle(browserStorage()));
  function changeCardStyle(nextStyle: CardStyle) {
    setCardStyle(nextStyle);
    persistCardStyle(browserStorage(), nextStyle);
  }

  const [musicSettings, setMusicSettings] = useState(() => loadMusicSettings(browserStorage()));
  function changeMusic(next: MusicSettings) {
    setMusicSettings(next);
    persistMusicSettings(browserStorage(), next);
  }
  useEffect(() => music.setSettings(musicSettings), [musicSettings]);
  const musicState = musicStateFor(session);
  useEffect(() => music.setState(musicState), [musicState]);

  const showError = (error: TransientErrorState['error']) => {
    errorIdRef.current += 1;
    setError({ id: errorIdRef.current, error });
  };

  const showNotice = (descriptor: NoticeDescriptor) => {
    noticeIdRef.current += 1;
    const next = { id: noticeIdRef.current, descriptor };
    setNoticeQueue((queue) => [...queue, next]);
  };

  // 会话状态由 reduceSession 推导；这里只处理副作用：身份持久化、错误与提示。
  useEffect(() => {
    const off = onMessage(socket, (msg: ServerMessage) => {
      dispatchSession({ msg, now: performance.now() });
      switch (msg.type) {
        case 'joined':
          setError(null);
          setJoinCount((n) => n + 1);
          setIdentity({ playerId: msg.playerId, name: nameRef.current, secret: msg.secret });
          saveIdentity({ playerId: msg.playerId, name: nameRef.current, secret: msg.secret });
          saveRoomCode(msg.roomCode);
          pendingLinkRoom = null;
          replaced = false;
          break;
        case 'gameStarted':
          setError(null);
          setNoticeQueue([]);
          showNotice({ key: 'gameStarted' });
          setReactions({});
          setLatestReaction(null);
          break;
        case 'reaction': {
          const id = ++reactionIdRef.current;
          setReactions((current) => ({ ...current, [msg.playerId]: { id, reaction: msg.reaction } }));
          setLatestReaction({ id, playerId: msg.playerId, reaction: msg.reaction });
          clearTimeout(reactionTimers.current.get(msg.playerId));
          reactionTimers.current.set(msg.playerId, setTimeout(() => {
            dropReaction(msg.playerId, id);
            // 读屏文字随铭牌一起清掉：否则之后切换语言会把这条旧表态再读一遍
            setLatestReaction((latest) => (latest?.id === id ? null : latest));
          }, REACTION_MS));
          break;
        }
        case 'events':
          setError(null);
          // 终局由桌心的胜者和戴冠座位交代，这一批不再弹提示。
          // 同一批里先失去影响力、再被淘汰时只报淘汰
          if (msg.events.some((e) => e.type === 'gameOver')) break;
          for (const e of msg.events) {
            if (e.type === 'eliminated') showNotice({ key: 'playerEliminated', playerId: e.playerId });
            if (e.type === 'influenceLost' && !msg.events.some((o) => o.type === 'eliminated' && o.playerId === e.playerId)) {
              showNotice({ key: 'influenceLostNotice', playerId: e.playerId });
            }
          }
          break;
        case 'error':
          showError(parseServerError(msg));
          if (msg.code === 'roomNotFound') clearRoomCode();
          if (!msg.inRoom) setConfirmLeave(false);
          break;
        case 'tunnelUrl':
          setError(null);
          break;
        case 'left':
          showError({ notice: msg.reason === 'replaced' ? 'replacedRoomNotice' : 'leftRoomNotice' });
          replaced = msg.reason === 'replaced';
          // 被其他标签页接管时，localStorage 里的身份属于新标签页，不能清掉。
          if (msg.reason === 'left') {
            clearRoomCode();
            clearIdentity();
          }
          setIdentity(null);
          setConfirmLeave(false);
          break;
      }
    });
    return off;
  }, [socket]);

  // 重连：socket 重新连接后，若本地有身份与房间码，自动重新加入
  useEffect(() => {
    const onConnect = () => {
      const intent = rejoinIntent(loadIdentity(), loadRoomCode(), pendingLinkRoom, replaced);
      if (intent) send(socket, intent);
    };
    socket.on('connect', onConnect);
    return () => {
      socket.off('connect', onConnect);
    };
  }, [socket]);

  useAutoDismiss(error, setError);
  // 提示条排队：发牌展示和对质舞台挡着牌桌时先不放，等它们收起；一条滑出后才放下一条，每条都停满时长。
  // NOTICE_GAP_MS 不短于 style.css 里牌局提示条的滑出（--notice-exit-duration）
  const noticeHeld = Boolean(showcase || showdown);
  useAutoDismiss(notice, setNotice);
  useEffect(() => {
    if (notice || noticeHeld || !noticeQueue.length) return;
    const timeout = setTimeout(() => {
      setNotice(noticeQueue[0]);
      setNoticeQueue((queue) => queue.slice(1));
    }, NOTICE_GAP_MS);
    return () => clearTimeout(timeout);
  }, [notice, noticeHeld, noticeQueue]);

  // 用一次往返估计客户端与服务器的时钟偏差，取最近几次中延迟最低的样本。
  useEffect(() => {
    let samples: { rtt: number; offset: number }[] = [];
    const sample = () => {
      if (!socket.connected) return;
      const sentAt = Date.now();
      socket.timeout(5000).emit('timeSync', (error: Error | null, serverNow: number) => {
        if (error || !Number.isFinite(serverNow)) return;
        const receivedAt = Date.now();
        const rtt = receivedAt - sentAt;
        if (rtt < 0) return;
        samples = [...samples.slice(-7), { rtt, offset: estimateServerOffset(sentAt, receivedAt, serverNow) }];
        setServerOffsetMs(samples.reduce((best, current) => current.rtt < best.rtt ? current : best).offset);
      });
    };
    const onConnect = () => {
      samples = [];
      setServerOffsetMs(null);
      sample();
    };
    socket.on('connect', onConnect);
    if (socket.connected) onConnect();
    const interval = setInterval(sample, 10_000);
    return () => {
      socket.off('connect', onConnect);
      clearInterval(interval);
    };
  }, [socket]);

  // 倒计时的 tick 留在显示它的小组件里（useCountdown），App 只传快照，免得整棵树每 250ms 重渲染（#17）
  const clock = useMemo<Clock>(() => ({ snapshot: countdownSnapshot, serverOffsetMs }), [countdownSnapshot, serverOffsetMs]);

  const me = identity?.playerId;
  // 发牌展示期间倒计时照走：轮到我行动时在展示里给出剩余时间
  const myMove = !!publicState && (
    (publicState.phase === 'choosingAction' && publicState.currentPlayerId === me) ||
    (publicState.phase === 'choosingExchange' && publicState.pending?.actorId === me)
  );

  function createRoom() {
    setError(null);
    send(socket, { type: 'createRoom', name });
  }

  function joinRoom() {
    setError(null);
    send(socket, {
      type: 'joinRoom',
      roomCode: roomCode.trim(),
      name,
      playerId: identity?.playerId,
      secret: identity?.secret,
      // 进的正是加入链接带来的房间：服务器据此区分经链接和手输房间码的访问
      via: pendingLinkRoom && roomCode.trim().toUpperCase() === pendingLinkRoom ? 'link' : 'code',
    });
  }

  function startGame() {
    send(socket, { type: 'startGame' });
  }

  function startTunnel() {
    dispatchSession({ patch: { tunnelLoading: true } });
    setError(null);
    send(socket, { type: 'startTunnel' });
  }

  function chooseAction(action: ActionType, targetId?: string) {
    setSelectedAction(null);
    send(socket, { type: 'chooseAction', action, targetId });
  }

  function leaveRoom() {
    setConfirmLeave(false);
    clearRoomCode(); // 断线时也算数：重连后不再自动回到这个房间
    send(socket, { type: 'leaveRoom' });
  }

  // 牌局进行中离开需确认（视为弃权）；大厅阶段或牌局结束后直接离开。
  function requestLeave() {
    if (publicState && publicState.phase !== 'gameOver') setConfirmLeave(true);
    else leaveRoom();
  }

  useEffect(() => {
    document.title = translate(locale, 'appTitle');
    document.documentElement.lang = locale;
  }, [locale]);

  // 大牌的画风全在 style.css 里按这个属性切换，组件不用知道风格
  useEffect(() => {
    const style = site.cardStyles ? cardStyle : 'default';
    document.documentElement.dataset.cardStyle = style;
    preloadCardStyle(style);
  }, [cardStyle, site.cardStyles]);

  return (
    <div className="app">
      <header className="header">
        <h1>{translate(locale, 'appTitle')}</h1>
        <div className="header-actions">
          <button className="ghost" onClick={() => setShowRules((v) => !v)}>
            {translate(locale, showRules ? 'closeRules' : 'rules')}
          </button>
          <button className="ghost" onClick={() => setShowSettings(true)}>
            {translate(locale, 'settings')}
          </button>
          {joined && (
            <button className="ghost" onClick={requestLeave}>
              {translate(locale, 'leaveRoom')}
            </button>
          )}
        </div>
      </header>

      {showRules && <RulesPanel locale={locale} onLocaleChange={changeLocale} onClose={closeRules} />}

      {showSettings && (
        <SettingsPanel
          locale={locale}
          onLocaleChange={changeLocale}
          cardStyle={site.cardStyles ? cardStyle : undefined}
          onCardStyleChange={changeCardStyle}
          music={musicSettings}
          onMusicChange={changeMusic}
          onClose={closeSettings}
        />
      )}

      {confirmLeave && (
        <LeaveConfirmation locale={locale} onConfirm={leaveRoom} onClose={closeLeaveConfirmation} />
      )}

      {showcase && (
        <DealShowcase
          showcase={showcase}
          locale={locale}
          clock={myMove ? clock : null}
          onClose={closeShowcase}
        />
      )}

      {showdown && publicState && (
        <ShowdownStage
          key={`${showdown.id}:${joinCount}`}
          view={showdown}
          state={publicState}
          me={me}
          locale={locale}
          clock={publicState.phase === 'showdown' ? clock : null}
          onFocus={(slot) => send(socket, { type: 'focusShowdownCard', slot })}
          onReveal={(cardId) => send(socket, { type: 'revealShowdownCard', cardId })}
          onDone={finishShowdown}
        />
      )}

      {!showdown && publicState?.phase === 'choosingLoss' && publicState.lossPlayerId === me && (
        <LossStage
          key={`${publicState.lossPlayerId}:${joinCount}`}
          hand={hand}
          locale={locale}
          clock={clock}
          onLose={(cardId) => send(socket, { type: 'resolveLoss', cardId })}
        />
      )}

      {/* 公开状态先于手牌到达：等抽到的牌进了手牌再开，免得先闪一下旧手牌 */}
      {!showdown && publicState?.phase === 'choosingExchange' && publicState.pending?.actorId === me && hand.length > (publicState.exchangeKeepCount ?? 0) && (
        <ExchangeStage
          key={joinCount}
          hand={hand}
          keepCount={publicState.exchangeKeepCount ?? 0}
          locale={locale}
          clock={clock}
          onKeep={(keepIds) => send(socket, { type: 'resolveExchange', keepIds })}
        />
      )}

      <TransientMessage
        value={error}
        className="error"
        regionClassName="error-region"
        role="alert"
        ariaLive="assertive"
        render={({ error }) => ('notice' in error ? translate(locale, error.notice) : localizeServerError(locale, error))}
      />

      {!joined ? (
        <>
          <EntryForm
            name={name}
            setName={setName}
            roomCode={roomCode}
            setRoomCode={setRoomCode}
            onCreate={createRoom}
            onJoin={joinRoom}
            locale={locale}
            invite={pendingLinkRoom}
          />
          <FilingFooter filing={site.filing} />
        </>
      ) : (
        <RoomView
          roomCode={joined}
          hostId={hostId}
          me={me}
          players={players}
          publicState={publicState}
          hand={hand}
          notice={notice}
          reactions={reactions}
          latestReaction={latestReaction}
          onDismissReaction={dropReaction}
          clock={showcase || showdown ? null : clock}
          log={log}
          motions={motions}
          onMotionDone={finishMotion}
          selectedAction={selectedAction}
          setSelectedAction={setSelectedAction}
          onStart={startGame}
          onAction={chooseAction}
          socket={socket}
          tunnelUrl={tunnelUrl}
          canStartTunnel={canStartTunnel}
          tunnelLoading={tunnelLoading}
          onStartTunnel={startTunnel}
          locale={locale}
        />
      )}
    </div>
  );
}
