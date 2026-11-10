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
