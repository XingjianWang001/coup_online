export function scheduleAutoDismiss<T extends { id: number }>(
  value: T,
  setValue: (update: (current: T | null) => T | null) => void,
): () => void {
  const timeout = setTimeout(() => {
    setValue((current) => current?.id === value.id ? null : current);
  }, 4000);
  return () => clearTimeout(timeout);
}
