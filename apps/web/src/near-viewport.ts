import { useEffect, useRef, useState } from "react";

/** Defer network work, not just the final blob image's browser decode. */
export function useNearViewport<T extends HTMLElement>(retain = true) {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      let frame=0;
      const check=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const box=element.getBoundingClientRect();const value=box.bottom>=-400&&box.top<=innerHeight+400;setNear(old=>retain?old||value:value);});};
      check();window.addEventListener('scroll',check,{passive:true});window.addEventListener('resize',check);
      return()=>{cancelAnimationFrame(frame);window.removeEventListener('scroll',check);window.removeEventListener('resize',check);};
    }
    const observer = new IntersectionObserver(entries => {
      const intersecting = entries.some(entry => entry.isIntersecting);
      if (intersecting || !retain) setNear(intersecting);
      if (intersecting && retain) observer.disconnect();
    }, { rootMargin: "400px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [retain]);
  return { ref, near };
}
