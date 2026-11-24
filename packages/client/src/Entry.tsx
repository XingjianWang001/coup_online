import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { isValidNickname } from '@coup/shared';
import { translate, type Locale } from './localization.ts';

// 创建/加入房间之前的入口（不是房间内的大厅阶段）
export function EntryForm(props: {
  name: string;
  setName: (v: string) => void;
  roomCode: string;
  setRoomCode: (v: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  locale: Locale;
}) {
  const canCreate = isValidNickname(props.name);
  const invalid = !!props.name && !canCreate;
  // 房间码填满（多半是从加入链接进来）时主按钮换成「加入」，和回车的选择一致
  const hasCode = props.roomCode.trim().length === 6;
  const canJoin = canCreate && hasCode;
  // 回车：填了完整房间码就加入，否则创建房间。输入法确认候选词的回车不算：Safari 先派发 compositionend，
  // 这时 isComposing 已是 false，只能靠 keyCode 229 认出来（WebKit bug 165004）
  const onEnter = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (canJoin) props.onJoin();
    else if (canCreate && !props.roomCode.trim()) props.onCreate();
  };
  return (
    <div className="entry-form">
      <label>
        {translate(props.locale, 'nickname')}
        <input
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
          onKeyDown={onEnter}
          placeholder={translate(props.locale, 'nicknamePlaceholder')}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? 'nickname-error' : undefined}
        />
      </label>
      {invalid && <span id="nickname-error" role="status">{translate(props.locale, 'errorInvalidName')}</span>}
      <button className={hasCode ? 'ghost' : 'primary'} onClick={props.onCreate} disabled={!canCreate}>
        {translate(props.locale, 'createRoom')}
      </button>
      <div className="divider">{translate(props.locale, 'or')}</div>
      <label>
        {translate(props.locale, 'roomCode')}
        <input
          value={props.roomCode}
          onChange={(e) => props.setRoomCode(e.target.value.toUpperCase())}
          onKeyDown={onEnter}
          placeholder={translate(props.locale, 'roomCodePlaceholder')}
          maxLength={6}
        />
      </label>
      <button className={hasCode ? 'primary' : 'ghost'} onClick={props.onJoin} disabled={!canJoin}>
        {translate(props.locale, 'joinRoom')}
      </button>
    </div>
  );
}

// 备案号为官方编号，任何语言下都不翻译；只在登记过的域名显示，未登记的域名（含 localhost、SSH 隧道）不显示页脚
const FILINGS: Record<string, { icp: string; police?: { code: string; label: string } }> = {
  'coup.davidxjwang.com': {
    icp: '粤ICP备2026157913号-1',
    police: { code: '44010602017448', label: '粤公网安备44010602017448号' },
  },
  'coup.surwhy.com': {
    icp: '粤ICP备2026157913号-2',
    police: { code: '44010602017609', label: '粤公网安备44010602017609号' },
  },
};

export function FilingFooter() {
  const filing = FILINGS[location.hostname];
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
