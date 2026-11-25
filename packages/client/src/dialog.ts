import { useLayoutEffect, useRef, type RefObject } from 'react';

// 原生模态 <dialog>：showModal() 提供 top layer、背景 inert、焦点限制在框内和 Esc / 返回手势；开关仍只看 React 是否挂载它。
// onCancel 接 Esc / 返回手势（舞台传空函数：牌局推进前关不掉）。卸载前 close()，浏览器把焦点还给打开前的元素。
// 用 layout effect：在首帧绘制前进入 top layer，未 showModal 的 <dialog> 是 display: none，不会闪一下。
export function useModalDialog(
  onCancel: () => void,
  dialogRef: RefObject<HTMLDialogElement>,
  initialFocusRef: RefObject<HTMLElement>,
) {
  // onCancel 放进 ref：调用方每次渲染传入新函数时，若作为依赖会让对话框每次都关了重开
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const open = () => {
      dialog.showModal();
      (initialFocusRef.current ?? dialog).focus();
    };
    const cancel = (event: Event) => {
      event.preventDefault();
      onCancelRef.current();
    };
    // 没有用户激活时连按 Esc，浏览器会跳过可取消的 cancel 直接关闭：还挂载着就重新打开，由 onCancel 决定是否真的关
    const closedByBrowser = () => {
      open();
      onCancelRef.current();
    };
    open();
    dialog.addEventListener('cancel', cancel);
    dialog.addEventListener('close', closedByBrowser);
    return () => {
      dialog.removeEventListener('cancel', cancel);
      dialog.removeEventListener('close', closedByBrowser);
      dialog.close();
    };
  }, [dialogRef, initialFocusRef]);
}
