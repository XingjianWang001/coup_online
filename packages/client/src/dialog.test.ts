import { describe, expect, it } from 'vitest';
import { lockScroll, strayFocusTarget, wrappedDialogFocus } from './dialog.ts';

describe('dialog keyboard focus', () => {
  it('wraps at either end and leaves interior movement to the browser', () => {
    const focusable = ['first', 'middle', 'last'];

    expect(wrappedDialogFocus(focusable, 'first', true)).toBe('last');
    expect(wrappedDialogFocus(focusable, 'last', false)).toBe('first');
    expect(wrappedDialogFocus(focusable, 'middle', false)).toBeNull();
  });
});

// 焦点任何时候都不能留在模态对话框外，否则键盘能操作被遮住的牌桌（旁观对质时 Tab + Enter 会替你收入）
describe('stray focus', () => {
  const node = (children: unknown[] = []) => {
    const n = { contains: (other: unknown) => other === n || children.includes(other) };
    return n;
  };
  const [first, radio, table] = [node(), node(), node()];
  const dialog = node([first, radio]);
  it.each([
    ['焦点跑到牌桌上（Tab 跳过单选组等）：拉回初始按钮', [dialog], table, first, first],
    ['没有初始按钮（旁观对质）：拉回对话框本身', [dialog], table, null, dialog],
    ['焦点在对话框里：不动', [dialog], radio, first, null],
    ['焦点在对话框本身：不动', [dialog], dialog, null, null],
    ['上面还叠着别的对话框：交给最上层的那个', [dialog, node()], table, first, null],
  ])('%s', (_name, modals, target, initial, expected) => {
    expect(strayFocusTarget(modals, dialog, target, initial)).toBe(expected);
  });
});

// 对质舞台盖着发牌展示时座位被接管或被淘汰：两个对话框在同一次渲染里关闭，先清理的是下面的发牌展示，页面滚动不能一直锁着
describe('scroll lock', () => {
  it('stays on until the last stacked dialog closes, in any order', () => {
    const body = { overflow: 'auto' };
    const closeShowcase = lockScroll(body);
    const closeStage = lockScroll(body);
    expect(body.overflow).toBe('hidden');
    closeShowcase();
    expect(body.overflow).toBe('hidden');
    closeStage();
    expect(body.overflow).toBe('auto');
  });
});
