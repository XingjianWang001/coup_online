import { useEffect, useState } from 'react';
import { describeCountdown, effectiveRemainingMs, remainingSinceReceipt } from './narration.ts';
import type { CountdownSnapshot } from './session.ts';
import { translate, type Locale } from './localization.ts';
import { HourglassIcon } from './icons.tsx';

export interface Clock {
  snapshot: CountdownSnapshot | null;
  serverOffsetMs: number | null;
}

// 只在显示倒计时的组件里 tick；浏览器暂停计时器后按实际经过时间重新计算，避免每次回调只减一秒造成滞后。
function useCountdown(clock: Clock | null): { countdown: string | null; urgent: boolean } {
  const snapshot = clock?.snapshot ?? null;
  const serverOffsetMs = clock?.serverOffsetMs ?? null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (snapshot?.remainingMs == null) return;
    const interval = setInterval(() => setTick((value) => value + 1), 250);
    return () => clearInterval(interval);
  }, [snapshot]);
  if (!snapshot) return { countdown: null, urgent: false };
  const remainingMs = remainingSinceReceipt(snapshot.remainingMs, snapshot.receivedAt, performance.now());
  const serverNow = serverOffsetMs == null ? null : Date.now() + serverOffsetMs;
  const effectiveRemaining = effectiveRemainingMs(remainingMs, snapshot.deadlineAt, serverNow);
  return {
    countdown: describeCountdown(remainingMs, snapshot.deadlineAt, serverNow),
    urgent: effectiveRemaining != null && effectiveRemaining <= 3000,
  };
}

export function DecisionTimer({ clock, locale }: { clock: Clock | null; locale: Locale }) {
  const { countdown, urgent } = useCountdown(clock);
  if (!countdown) return null;
  return (
    <span className={`decision-timer${urgent ? ' urgent' : ''}`} role="timer" aria-label={translate(locale, 'timeToAct', { time: countdown })}>
      <HourglassIcon />
      {countdown}
    </span>
  );
}
