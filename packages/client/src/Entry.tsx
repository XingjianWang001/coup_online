import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { isValidNickname } from '@coup/shared';
import { translate, type Locale } from './localization.ts';

// 房间码输入的清洗：粘贴整条加入链接时取出 room 参数，其余只留字母数字（从聊天里复制常带空格），转大写后截到 6 位
export function normalizeRoomCode(raw: string): string {
  const fromLink = /[?&]room=([^&#\s]*)/i.exec(raw)?.[1];
  return (fromLink ?? raw).replace(/[^0-9a-z]/gi, '').toUpperCase().slice(0, 6);
}

// 创建/加入房间之前的入口（不是房间内的大厅阶段）
export function EntryForm(props: {
  name: string;
  setName: (v: string) => void;
  roomCode: string;
  setRoomCode: (v: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  locale: Locale;
  /** 加入链接带来的房间码：入口只给「加入这个房间」一条路，改为创建新房间收成一个文字按钮 */
  invite: string | null;
}) {
  const [invited, setInvited] = useState(() => props.invite?.length === 6 && props.roomCode === props.invite);
  const canCreate = isValidNickname(props.name);
  const invalid = !!props.name && !canCreate;
  // 开始填房间码，主按钮就换成「加入」：金色的那个按钮就是回车会做的事，房间码没填满时两边都不亮、回车也不做
  const joining = !!props.roomCode;
  const canJoin = canCreate && props.roomCode.length === 6;
  // 输入法确认候选词的回车不算：Safari 先派发 compositionend，
  // 这时 isComposing 已是 false，只能靠 keyCode 229 认出来（WebKit bug 165004）
  const onEnter = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (joining) {
      if (canJoin) props.onJoin();
    } else if (canCreate) props.onCreate();
  };
  const nickname = (
    <>
      <label>
        {translate(props.locale, 'nickname')}
        <input
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
          onKeyDown={onEnter}
          placeholder={translate(props.locale, 'nicknamePlaceholder')}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? 'nickname-error' : undefined}
          // 链接进来就把键盘交给昵称；改为创建新房间后表单重排、昵称框重新挂载，焦点也跟回来，不掉到 body
          autoFocus={!!props.invite}
          enterKeyHint="go"
        />
      </label>
      {invalid && <span id="nickname-error" role="status">{translate(props.locale, 'errorInvalidName')}</span>}
    </>
  );
  if (invited) {
    return (
      <div className="entry-form">
        <p className="entry-invite">{translate(props.locale, 'joinRoom')} <b>{props.roomCode}</b></p>
        {nickname}
        <button className="primary" onClick={props.onJoin} disabled={!canJoin}>
          {translate(props.locale, 'joinRoom')}
        </button>
        <button
          className="entry-switch"
          onClick={() => {
            props.setRoomCode('');
            setInvited(false);
          }}
        >
          {translate(props.locale, 'createInstead')}
        </button>
      </div>
    );
  }
  return (
    <div className="entry-form">
      {nickname}
      <button className={joining ? 'ghost' : 'primary'} onClick={props.onCreate} disabled={!canCreate}>
        {translate(props.locale, 'createRoom')}
      </button>
      <div className="divider">{translate(props.locale, 'or')}</div>
      <label>
        {translate(props.locale, 'roomCode')}
        <input
          value={props.roomCode}
          onChange={(e) => props.setRoomCode(normalizeRoomCode(e.target.value))}
          onKeyDown={onEnter}
          placeholder={translate(props.locale, 'roomCodePlaceholder')}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
        />
      </label>
      <button className={joining ? 'primary' : 'ghost'} onClick={props.onJoin} disabled={!canJoin}>
        {translate(props.locale, 'joinRoom')}
      </button>
    </div>
  );
}

// 备案号为官方编号，任何语言下都不翻译；按访问域名由服务端的 /api/site 给出，未登记的域名没有，不显示页脚
export interface Filing {
  icp: string;
  police?: { code: string; label: string };
}

export function FilingFooter({ filing }: { filing?: Filing }) {
  if (!filing) return null;
  return (
    <footer className="filing">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
        {filing.icp}
      </a>
      {filing.police && (
        <a
          href={`https://beian.mps.gov.cn/#/query/webSearch?code=${filing.police.code}`}
          target="_blank"
          rel="noreferrer"
        >
          <img src="/beian-police.png" alt="" width={14} height={15} />
          {filing.police.label}
        </a>
      )}
    </footer>
  );
}
