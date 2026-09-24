import { describe, expect, it } from 'vitest';
import { wrappedDialogFocus } from './dialog.ts';

describe('dialog keyboard focus', () => {
  it('wraps at either end and leaves interior movement to the browser', () => {
    const focusable = ['first', 'middle', 'last'];

    expect(wrappedDialogFocus(focusable, 'first', true)).toBe('last');
    expect(wrappedDialogFocus(focusable, 'last', false)).toBe('first');
    expect(wrappedDialogFocus(focusable, 'middle', false)).toBeNull();
  });
});
