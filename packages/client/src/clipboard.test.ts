import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './clipboard.ts';

const URL = 'https://example.com?room=ABC123';

afterEach(() => vi.unstubAllGlobals());

describe('copyToClipboard', () => {
  it('在点击仍有用户激活时复制，不等待异步 API 拒绝', async () => {
    let active = true;
    let rejectWrite!: (reason: Error) => void;
    const writeText = vi.fn(() => new Promise<void>((_, reject) => { rejectWrite = reject; }));
    const textarea = { value: '', style: {}, setAttribute: vi.fn(), select: vi.fn() };
    const execCommand = vi.fn(() => active);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('document', {
      createElement: vi.fn(() => textarea),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand,
    });

    const result = copyToClipboard(URL);
    active = false;
    if (writeText.mock.calls.length) rejectWrite(new Error('clipboard permission denied'));

    expect(await result).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(textarea.value).toBe(URL);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('旧复制方式不可用时使用异步剪贴板 API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const textarea = { value: '', style: {}, setAttribute: vi.fn(), select: vi.fn() };
    const removeChild = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('document', {
      createElement: vi.fn(() => textarea),
      body: { appendChild: vi.fn(), removeChild },
      execCommand: vi.fn(() => false),
    });

    expect(await copyToClipboard(URL)).toBe(true);
    expect(writeText).toHaveBeenCalledWith(URL);
    expect(removeChild).toHaveBeenCalledWith(textarea);
  });

  it('两种复制方式都失败时返回失败', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const textarea = { value: '', style: {}, setAttribute: vi.fn(), select: vi.fn() };
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('document', {
      createElement: vi.fn(() => textarea),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand: vi.fn(() => false),
    });

    expect(await copyToClipboard(URL)).toBe(false);
  });
});
