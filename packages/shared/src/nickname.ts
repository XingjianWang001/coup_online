const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const MAX_NICKNAME_CHARACTERS = 12;

export function isValidNickname(name: unknown): name is string {
  // Bound raw input before segmenting: one grapheme can contain many combining marks.
  if (typeof name !== 'string' || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name)) return false;
  const trimmed = name.trim();
  return trimmed.length > 0 && Array.from(graphemes.segment(trimmed)).length <= MAX_NICKNAME_CHARACTERS;
}
