import { useEffect, useRef } from "react";
import { createOnboardingMeshRenderer } from "@/onboarding/onboardingMeshRenderer.js";
import { useResolvedThemeHeroPalette } from "@/openWorkspacePageThemeHero.js";

/** 与引导页共用 shader；只有真实新记录/选择才产生一次有界动态，静止时不占用帧循环。 */
export function OmpInteractionHeroBackground({
  active,
  pulseKey,
}: {
  active: boolean;
  pulseKey: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<(animate: boolean) => void>(() => {});
  const previousKey = useRef(pulseKey);
  const { meshLight } = useResolvedThemeHeroPalette();
  useEffect(() => {
    const canvas = ref.current;
    if (!active || !canvas) return;
    const color = [1, 3, 5].map(
      (offset) => parseInt(meshLight.slice(offset, offset + 2), 16) / 255,
    ) as [number, number, number];
    let renderer: ReturnType<typeof createOnboardingMeshRenderer> = null;
    let frame = 0;
    let visible = false;
    let lost = false;
    let disposed = false;
    let phase = 0.7;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const draw = (animate: boolean) => {
      stop();
      if (disposed || lost || !visible || document.hidden) return;
      const start = performance.now();
      let last = 0;
      const dynamic = animate && !reduced.matches;
      const tick = (now: number) => {
        frame = 0;
        if (disposed || lost || !visible || document.hidden) return;
        const { width, height } = canvas.getBoundingClientRect();
        if (!width || !height) return;
        renderer ??= createOnboardingMeshRenderer(canvas);
        if (!renderer) return;
        const progress = dynamic ? Math.min(1, (now - start) / 700) : 0;
        if (!last || now - last >= 1000 / 24 || progress === 1) {
          renderer.draw(phase + progress * 0.35, width, height, color);
          canvas.style.opacity = "0.7";
          last = now;
        }
        if (dynamic && progress < 1) frame = requestAnimationFrame(tick);
        else phase += progress * 0.35;
      };
      tick(start);
    };
    const redraw = () => draw(false);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      redraw();
    });
    const resize = new ResizeObserver(redraw);
    const contextLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      stop();
      canvas.style.opacity = "0";
    };
    const contextRestored = () => {
      renderer?.dispose();
      renderer = null;
      lost = false;
      redraw();
    };
    drawRef.current = draw;
    observer.observe(canvas);
    resize.observe(canvas);
    reduced.addEventListener("change", redraw);
    document.addEventListener("visibilitychange", redraw);
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
    return () => {
      disposed = true;
      stop();
      drawRef.current = () => {};
      observer.disconnect();
      resize.disconnect();
      reduced.removeEventListener("change", redraw);
      document.removeEventListener("visibilitychange", redraw);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      renderer?.dispose();
    };
  }, [active, meshLight]);
  useEffect(() => {
    if (previousKey.current !== pulseKey) {
      previousKey.current = pulseKey;
      drawRef.current(Boolean(pulseKey));
    }
  }, [pulseKey]);
  return active ? (
    <canvas
      ref={ref}
      data-testid="omp-agent-interactions-mesh"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
    />
  ) : null;
}
