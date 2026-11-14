import { useEffect, useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react';

const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';

/**
 * deps 变化（元素里换了内容）时，让元素高度从旧值平滑过渡到新值。
 * 旧高度由 ResizeObserver 持续记录：它在 layout 之后才回调，所以 useLayoutEffect 里读到的还是换内容之前的高度；
 * 窗口缩放后不会拿到过期值，动画中途再切换也从屏幕上的当前高度起步。
 * 过渡期间 overflow: hidden，会暂时裁掉溢出元素外的气泡（如行动提示），只持续动画那几百毫秒。
 */
export function useSmoothHeight(
  ref: RefObject<HTMLElement>,
  deps: DependencyList,
  { enabled = true, fade = false }: { enabled?: boolean; fade?: boolean } = {},
): void {
  const last = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => { last.current = entry.borderBoxSize[0].blockSize; });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 先停掉上一段过渡，量到的才是新内容的自然高度
    el.getAnimations().forEach((a) => a.cancel());
    const next = el.getBoundingClientRect().height;
    const prev = last.current;
    if (prev == null) {
      last.current = next;
      return;
    }
    if (!enabled || Math.abs(prev - next) < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.animate(
      [{ height: `${prev}px`, overflow: 'hidden' }, { height: `${next}px`, overflow: 'hidden' }],
      { duration: 280, easing: EASE_OUT },
    );
    if (fade) el.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  }, deps); // 由调用方声明「什么算换了内容」
}
