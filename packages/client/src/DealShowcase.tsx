import { useRef, useState, type CSSProperties } from 'react';
import { roleDescription } from './rules.ts';
import { useDialogFocus } from './dialog.ts';
import type { Showcase } from './session.ts';
import { translate, type Locale } from './localization.ts';
import { DecisionTimer, type Clock } from './clock.tsx';
import { BigCard } from './icons.tsx';

// 发牌展示：大牌取自 prototype/role-icons 分支（1868656）的方案 C（线描图标 + 圆章 + 扑克式角标），只在这里出现。
// 动画全在 CSS：--i 为牌位、--n 为牌数，用来算出各牌飞向屏幕上方同一个牌堆点的位移。
export function DealShowcase({ showcase, locale, clock, onClose }: {
  showcase: Showcase;
  locale: Locale;
  clock: Clock | null;
  onClose: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [openTip, setOpenTip] = useState<number | null>(null);
  useDialogFocus(onClose, dialogRef, confirmRef);

  return (
    <div className="overlay showcase-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="showcase"
        role="dialog"
        aria-modal="true"
        aria-label={translate(locale, 'showcaseDeal')}
        style={{ '--n': showcase.cards.length } as CSSProperties}
        onClick={(event) => {
          event.stopPropagation();
          setOpenTip(null);
        }}
      >
        <div className="showcase-cards">
          {showcase.cards.map((card, i) => {
            const tipId = `showcase-tip-${i}`;
            return (
              <div key={i} className="showcase-slot" style={{ '--i': i, '--order': i, '--tip': `var(--${card.role})` } as CSSProperties}>
                <div className="showcase-flipper dealt">
                  <div className="card-back" aria-hidden="true" />
                  <button
                    type="button"
                    className="showcase-face"
                    aria-describedby={tipId}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenTip(openTip === i ? null : i);
                    }}
                  >
                    <BigCard role={card.role} locale={locale} />
                  </button>
                </div>
                <span id={tipId} role="tooltip" className={`showcase-tip${openTip === i ? ' open' : ''}`}>
                  {roleDescription(locale, card.role)}
                </span>
              </div>
            );
          })}
        </div>
        <div className="showcase-actions">
          <DecisionTimer clock={clock} locale={locale} />
          <button ref={confirmRef} onClick={onClose}>{translate(locale, 'confirm')}</button>
        </div>
      </div>
    </div>
  );
}
