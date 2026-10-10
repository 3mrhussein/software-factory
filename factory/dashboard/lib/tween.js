// Animates numeric arrays toward new targets so charts morph instead of jump
// when live data changes. Nulls (gaps) switch instantly.
import { useEffect, useRef, useState } from './h.js';

const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (t) => 1 - Math.pow(1 - t, 3);

export function useTweened(target, duration = 650) {
  const [value, setValue] = useState(() => target.map((v) => (v == null ? v : 0)));
  const from = useRef(value);
  const key = JSON.stringify(target);
  useEffect(() => {
    if (reduced()) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf;
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const k = ease(t);
      const next = target.map((v, i) => (v == null || a[i] == null ? v : a[i] + (v - a[i]) * k));
      setValue(next);
      if (t < 1) raf = requestAnimationFrame(frame);
      else from.current = target;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      from.current = target;
    };
  }, [key]);
  return value;
}
