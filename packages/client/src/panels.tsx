import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { coinLegend, roleDescription, roleName, ROLES, rulesFor, type RuleLevel } from './rules.ts';
import { useDialogFocus } from './dialog.ts';
import { CARD_STYLES, type CardStyle } from './cardStyle.ts';
import { LANGUAGE_OPTIONS, translate, type Locale } from './localization.ts';
import { CoinIcon, RoleIcon } from './icons.tsx';

interface SettingsProps {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  cardStyle?: CardStyle;
  onCardStyleChange: (style: CardStyle) => void;
  onClose: () => void;
}

export function SettingsPanel(props: SettingsProps) {
  const [showCredits, setShowCredits] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const creditsButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = showCredits ? () => setShowCredits(false) : props.onClose;
  useDialogFocus(close, dialogRef, closeButtonRef);

  const previousView = useRef(showCredits);
  useLayoutEffect(() => {
    if (previousView.current !== showCredits) {
      (showCredits ? closeButtonRef : creditsButtonRef).current?.focus();
      previousView.current = showCredits;
    }
  }, [showCredits]);

  return (
    <div className="overlay settings-overlay" onClick={close}>
      <div
        ref={dialogRef}
        className="panel settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-heading">
          <h2 id="settings-title">{translate(props.locale, showCredits ? 'credits' : 'settingsTitle')}</h2>
          <button ref={closeButtonRef} className="ghost" onClick={close}>
            {translate(props.locale, showCredits ? 'backToSettings' : 'closeSettings')}
          </button>
        </div>
        {showCredits ? (
          <CreditsList key={props.locale} locale={props.locale} />
        ) : (
          <>
            <SettingsOptions {...props} />
            <button ref={creditsButtonRef} onClick={() => setShowCredits(true)}>
              {translate(props.locale, 'credits')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function CreditsList({ locale }: { locale: Locale }) {
  const [rows, setRows] = useState<{ name: string; contribution: string }[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/credits?locale=${locale}`, { signal: controller.signal });
        if (!response.ok) throw new Error();
        setRows(await response.json());
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [locale]);

  if (failed) return <p role="status">{translate(locale, 'creditsUnavailable')}</p>;
  if (!rows) return <p role="status">{translate(locale, 'creditsLoading')}</p>;
  if (!rows.length) return <p>{translate(locale, 'creditsEmpty')}</p>;
  return (
    <ul className="credits-list">
      {rows.map(({ name, contribution }) => (
        <li key={name}><strong>{name}</strong> · {contribution}</li>
      ))}
    </ul>
  );
}

function SettingsOptions(props: SettingsProps) {
  return (
    <>
      <fieldset className="language-settings">
        <legend>{translate(props.locale, 'language')}</legend>
        <div className="language-options">
          {LANGUAGE_OPTIONS.map((option) => (
            <label className="language-option" key={option.locale}>
              <input
                type="radio"
                name="locale"
                value={option.locale}
                checked={props.locale === option.locale}
                onChange={() => props.onLocaleChange(option.locale)}
              />
              <span lang={option.locale}>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {props.cardStyle && (
        <fieldset className="language-settings">
          <legend>{translate(props.locale, 'cardStyle')}</legend>
          <div className="language-options">
            {CARD_STYLES.map((style) => (
              <label className="language-option" key={style}>
                <input
                  type="radio"
                  name="cardStyle"
                  value={style}
                  checked={props.cardStyle === style}
                  onChange={() => props.onCardStyleChange(style)}
                />
                <span>{translate(props.locale, style === 'totem' ? 'cardStyleTotem' : 'cardStyleDefault')}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </>
  );
}

export function LeaveConfirmation(props: { locale: Locale; onConfirm: () => void; onClose: () => void }) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(props.onClose, dialogRef, cancelButtonRef);

  return (
    <div className="overlay" onClick={props.onClose}>
      <div
        ref={dialogRef}
        className="panel"
        role="alertdialog"
        aria-modal="true"
        aria-label={translate(props.locale, 'leaveRoom')}
        aria-describedby="leave-confirmation-description"
        onClick={(event) => event.stopPropagation()}
      >
        <p id="leave-confirmation-description">{translate(props.locale, 'leaveConfirmation')}</p>
        <button onClick={props.onConfirm}>{translate(props.locale, 'confirmLeave')}</button>
        <button ref={cancelButtonRef} className="ghost" onClick={props.onClose}>
          {translate(props.locale, 'cancel')}
        </button>
      </div>
    </div>
  );
}

export function RulesPanel({
  locale,
  onLocaleChange,
  onClose,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  onClose: () => void;
}) {
  const [level, setLevel] = useState<RuleLevel>('quick');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(onClose, dialogRef, closeButtonRef);

  return (
    <div className="overlay rules-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="panel rules"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rules-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-heading rules-heading">
          <h2 id="rules-title">{translate(locale, 'rulesTitle')}</h2>
          <div className="rules-heading-actions">
            <select
              value={locale}
              aria-label={translate(locale, 'language')}
              onChange={(event) => onLocaleChange(event.currentTarget.value as Locale)}
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <option key={option.locale} value={option.locale}>{option.label}</option>
              ))}
            </select>
            <button ref={closeButtonRef} className="ghost" onClick={onClose}>
              {translate(locale, 'closeRules')}
            </button>
          </div>
        </div>
        <div className="rules-level-switch" role="group" aria-label={translate(locale, 'rulesLevel')}>
          {(['quick', 'full'] as const).map((option) => (
            <button
              key={option}
              className={level === option ? 'selected' : ''}
              aria-pressed={level === option}
              onClick={() => setLevel(option)}
            >
              {translate(locale, option === 'quick' ? 'quickRules' : 'fullRules')}
            </button>
          ))}
        </div>
        <div className="rules-body">
          {rulesFor(locale, level).map((section) => (
            <Fragment key={section.id}>
              {section.roleReferenceBefore && (
                <section className="rule-section role-reference" aria-labelledby="rule-roles">
                  <h3 id="rule-roles">{translate(locale, 'rolesTitle')}</h3>
                  <div className="role-reference-list">
                    {ROLES.map((role) => (
                      <div key={role} className={`role-reference-item role--${role}`}>
                        <RoleIcon role={role} />
                        <div>
                          <b>{roleName(locale, role)}</b>
                          <p>{roleDescription(locale, role)}</p>
                        </div>
                      </div>
                    ))}
                    <div className="role-reference-item coin-legend">
                      <CoinIcon />
                      <div>
                        <b>{coinLegend(locale).name}</b>
                        <p>{coinLegend(locale).description}</p>
                      </div>
                    </div>
                  </div>
                </section>
              )}
              <section
                className={`rule-section${section.onlineOnly ? ' online-rules' : ''}`}
                aria-labelledby={`rule-${section.id}`}
              >
                <h3 id={`rule-${section.id}`}>{section.title}</h3>
                <p>{section.body}</p>
                {section.items && (
                  <ul>
                    {section.items.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                )}
              </section>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
