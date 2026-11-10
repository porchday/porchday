import { useEffect, useRef, useState } from "react";

/** Screen-sized runway for photos; ordinary callers retain the 400px default.
 * Hysteresis keeps opened media warm until it is much farther from the viewport. */
export function useNearViewport<T extends HTMLElement>(retain = true, screens = 0, retainScreens = screens) {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const margin = () => screens ? Math.ceil(innerHeight * screens) : 400;
    const outerMargin = () => retainScreens ? Math.ceil(innerHeight * retainScreens) : 400;
    let observers: IntersectionObserver[] = [], frame = 0;
    const check = () => {
      const box = element.getBoundingClientRect();
      const enters = box.bottom >= -margin() && box.top <= innerHeight + margin();
      const stays = box.bottom >= -outerMargin() && box.top <= innerHeight + outerMargin();
      setNear(old => retain ? old || enters : enters || (old && stays));
    };
    const setup = () => {
      observers.forEach(observer => observer.disconnect());
      check();
      if (typeof IntersectionObserver === "undefined") return;
      const enter = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { setNear(true); if (retain) enter.disconnect(); }
      }, { rootMargin: `${margin()}px` });
      observers = [enter]; enter.observe(element);
      if (!retain) {
        const leave = new IntersectionObserver(entries => {
          if (!entries.some(entry => entry.isIntersecting)) setNear(false);
        }, { rootMargin: `${outerMargin()}px` });
        observers.push(leave); leave.observe(element);
      }
    };
    const scroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(check); };
    setup(); window.addEventListener('resize', setup);
    if (typeof IntersectionObserver === 'undefined') window.addEventListener('scroll', scroll, {passive:true});
    return () => { observers.forEach(observer => observer.disconnect()); cancelAnimationFrame(frame); window.removeEventListener('resize', setup); window.removeEventListener('scroll', scroll); };
  }, [retain, screens, retainScreens]);
  return { ref, near };
}
