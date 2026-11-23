import { useEffect, useRef, type RefObject } from 'react';

export function wrappedDialogFocus<T>(
  focusable: ArrayLike<T>,
  active: T | null,
  movingBackward: boolean,
): T | null {
  if (!focusable.length) return null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (movingBackward && active === first) return last;
  if (!movingBackward && active === last) return first;
  return null;
}

// 焦点落到最上层模态对话框之外时要拉回的元素（初始按钮，没有就是对话框本身）；焦点在对话框内或它不是最上层时为 null
export function strayFocusTarget<T extends { contains(other: Node | null): boolean }>(
  modals: ArrayLike<unknown>,
  dialog: T,
  target: unknown,
  initial: T | null,
): T | null {
  if (modals[modals.length - 1] !== dialog || dialog.contains(target as Node | null)) return null;
  return initial ?? dialog;
}

export function useDialogFocus(
  onClose: () => void,
  dialogRef: RefObject<HTMLDivElement>,
  initialFocusRef: RefObject<HTMLElement>,
) {
  // onClose 放进 ref：调用方每次渲染传入新函数时，若作为依赖会让焦点每次都跳回初始按钮。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      // 对话框叠开时（如发牌展示盖在规则上）只由最上层的那个响应
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals[modals.length - 1] !== dialogRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const target = wrappedDialogFocus(
        focusable,
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
        event.shiftKey,
      );
      if (target) {
        event.preventDefault();
        target.focus();
      }
    };
    // 焦点无论怎么跑到对话框外（Tab 跳过单选组、旁观对质时没有可聚焦的控件……）都拉回来，否则键盘能操作被遮住的牌桌
    const onFocusIn = (event: FocusEvent) => {
      if (!dialogRef.current) return;
      strayFocusTarget(document.querySelectorAll('[aria-modal="true"]'), dialogRef.current, event.target, initialFocusRef.current)?.focus();
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    (initialFocusRef.current ?? dialogRef.current)?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      previouslyFocused?.focus();
    };
  }, [dialogRef, initialFocusRef]);
}
