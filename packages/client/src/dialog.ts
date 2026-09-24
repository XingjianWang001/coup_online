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
