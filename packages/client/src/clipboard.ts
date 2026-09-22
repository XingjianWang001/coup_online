function execCommandCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  let appended = false;
  try {
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    appended = true;
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (appended) document.body.removeChild(ta);
  }
}

export function copyToClipboard(text: string): Promise<boolean> {
  // 在点击事件仍有用户激活时先同步复制；异步 API 若延迟拒绝，回退可能已失去权限。
  if (execCommandCopy(text)) return Promise.resolve(true);
  if (!navigator.clipboard?.writeText) return Promise.resolve(false);
  try {
    return navigator.clipboard.writeText(text).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}
