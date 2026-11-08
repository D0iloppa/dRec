import { useEffect, useRef, type ReactElement } from "react";

// Live input waveform for the recording view (voice-memo style): the recent input levels scroll left up to a playhead, the space after it is
// dotted.  One <canvas>, one requestAnimationFrame loop only while recording, a level sample every STEP_MS (the peak since the last sample).

const STEP_MS = 60;
const BAR = 3;
const GAP = 2;
const HISTORY = 600;
const PLAYHEAD = 0.66;

export function Waveform({ recording, paused, level }: { recording: boolean; paused: boolean; level: () => number }): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<number[]>([]);
  const lastRun = useRef(recording || paused);
  if (!recording && !paused && lastRun.current) history.current = []; // a new recording starts empty
  lastRun.current = recording || paused;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return undefined;
    const css = getComputedStyle(el);
    const color = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
    const live = color("--rec", "#eb5757"), idle = color("--text-dim", "#787774"), head = color("--accent", "#2383e2");
    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth, h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const mid = h / 2, x0 = Math.round(w * PLAYHEAD), step = BAR + GAP;
      const levels = history.current, n = Math.min(levels.length, Math.floor(x0 / step));
      ctx.fillStyle = recording ? live : idle;
      for (let i = 0; i < n; i += 1) {
        const v = levels[levels.length - n + i] ?? 0;
        const half = Math.max(1.5, Math.sqrt(v) * (mid - 4));
        ctx.fillRect(x0 - (n - i) * step, mid - half, BAR, half * 2);
      }
      ctx.fillStyle = idle;
      for (let x = (n ? x0 + GAP : 0); x < w; x += step * 2) if (x < x0 - n * step || x > x0) ctx.fillRect(x, mid - 1, BAR, 2);
      ctx.fillStyle = head;
      ctx.fillRect(x0 - 1, 6, 2, h - 12);
      ctx.beginPath(); ctx.arc(x0, 6, 4, 0, Math.PI * 2); ctx.arc(x0, h - 6, 4, 0, Math.PI * 2); ctx.fill();
    };
    if (!recording) { draw(); const onResize = (): void => draw(); window.addEventListener("resize", onResize); return () => window.removeEventListener("resize", onResize); }
    let raf = 0, last = performance.now(), peak = 0;
    const tick = (now: number): void => {
      peak = Math.max(peak, level());
      if (now - last >= STEP_MS) {
        last = now;
        history.current.push(peak); peak = 0;
        if (history.current.length > HISTORY) history.current.splice(0, history.current.length - HISTORY);
        draw();
      }
      raf = requestAnimationFrame(tick);
    };
    draw();
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recording, paused, level]);

  return <canvas ref={canvas} className={`rec-wave${recording ? " is-live" : ""}`} aria-hidden="true" />;
}
