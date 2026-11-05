import { useLayoutEffect, type RefObject } from 'react';

const sharedRects = new Map<string, DOMRect>();
const EASE = 'cubic-bezier(.22,1,.36,1)';

/**
 * FLIP morph for [data-morph] elements. Uses a module-level rect store so a
 * newly mounted view (mode switch) can animate from the outgoing view's
 * geometry, and re-renders within one view (sub-page state change) animate too.
 */
export function useMorphTransition(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, DOMRect>();
    root.querySelectorAll<HTMLElement>('[data-morph]').forEach((el) => {
      const key = el.getAttribute('data-morph');
      if (!key) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      if (el.dataset.morphing === '1') {
        const target = sharedRects.get(key);
        if (target) next.set(key, target);
        return;
      }
      const prev = sharedRects.get(key);
      if (prev && !reduced) {
        const dx = (prev.left + prev.width / 2) - (rect.left + rect.width / 2);
        const dy = prev.top - rect.top;
        const sx = prev.width / rect.width;
        const sy = prev.height / rect.height;
        const moved = Math.abs(dx) > 1 || Math.abs(dy) > 1;
        const scaled = Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02;
        if (moved || scaled) {
          const frames = key === 'title'
            ? [
                { transform: `translate(${dx}px, ${dy}px) scale(${sy})`, transformOrigin: 'center top' },
                { transform: 'none', transformOrigin: 'center top' },
              ]
            : [
                { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: 'center top' },
                { transform: 'none', transformOrigin: 'center top' },
              ];
          el.dataset.morphing = '1';
          const anim = el.animate(frames, { duration: 480, easing: EASE, fill: 'both' });
          anim.onfinish = () => { delete el.dataset.morphing; };
        }
      }
      next.set(key, rect);
    });
    sharedRects.clear();
    next.forEach((r, k) => sharedRects.set(k, r));
  });
}
