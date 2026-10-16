/**
 * (E5) Calls `done` once `el` has stopped moving on screen (its top the same for `still` frames in a row), or
 * after `maxMs`, whichever is first. A smooth scroll to a row far down a long page takes seconds on a phone; a
 * highlight that starts at the click is gone before the row arrives. Returns a cancel.
 */
export function afterScrollSettles(el: Element, done: () => void, { still = 6, maxMs = 4000 }: { still?: number; maxMs?: number } = {}): () => void {
  let last = Number.NaN;
  let same = 0;
  let raf = 0;
  const t0 = performance.now();
  let off = false;
  const tick = () => {
    if (off) return;
    const top = el.getBoundingClientRect().top;
    same = top === last ? same + 1 : 0;
    last = top;
    if (same >= still || performance.now() - t0 >= maxMs) {
      done();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    off = true;
    cancelAnimationFrame(raf);
  };
}
