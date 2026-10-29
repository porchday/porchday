/** A visible DOM milestone after a paint opportunity, not proof of physical display.
 * Call only for opt-in diagnostics. No timers, content, URLs or IDs are retained.
 */
export function observeVisibleMilestone(element: HTMLElement, valid: () => boolean, record: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined' || typeof element.checkVisibility !== 'function') return () => {};
  let stopped = false, intersecting = false, frame = 0;
  const img = element instanceof HTMLImageElement ? element : null;
  let decoded = !img, decodedSource = "";
  const visible = () => {
    if (stopped || !intersecting || !decoded || !element.isConnected || document.visibilityState !== 'visible' || !valid()) return false;
    if (img && (!img.complete || !img.naturalWidth || img.currentSrc !== decodedSource)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth &&
      element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
  };
  function stop() {
    stopped = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    document.removeEventListener('visibilitychange', schedule);
    img?.removeEventListener('load', decode);
    img?.removeEventListener('error', stop);
  }
  function schedule() {
    cancelAnimationFrame(frame);
    if (!visible()) return;
    frame = requestAnimationFrame(() => {
      if (!visible()) return;
      frame = requestAnimationFrame(() => {
        if (!visible()) return;
        stop();
        record();
      });
    });
  }
  function decode() {
    if (!img || !img.complete || !img.naturalWidth) return;
    const source = img.currentSrc;
    decoded = false;
    void img.decode().then(() => {
      if (stopped || img.currentSrc !== source) return;
      decodedSource = source;
      decoded = true;
      schedule();
    }).catch(() => { /* A failed decode is not a successful visible photo. */ });
  }
  const observer = new IntersectionObserver(entries => {
    intersecting = entries.some(entry => entry.target === element && entry.isIntersecting && entry.intersectionRatio > 0);
    schedule();
  }, {threshold: 0});
  observer.observe(element);
  document.addEventListener('visibilitychange', schedule);
  img?.addEventListener('load', decode);
  img?.addEventListener('error', stop);
  decode();
  return stop;
}
