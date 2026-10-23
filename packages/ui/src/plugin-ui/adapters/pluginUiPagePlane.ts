import { autoUpdate } from "@floating-ui/dom";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import type { SandboxPagePlacement } from "../contract.js";

function parkingRoot(): HTMLElement {
  const existing = document.querySelector<HTMLElement>("[data-sandbox-page-parking]");
  if (existing) return existing;
  const root = document.createElement("div");
  root.dataset.sandboxPageParking = "true";
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;overflow:visible";
  document.body.append(root);
  return root;
}

function cssZoom(node: HTMLElement): number {
  const native = (node as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof native === "number" && native > 0) return native;
  // Chromium 120 尚无 currentCSSZoom；zoom 是累积值，不能只读直接父元素。
  let zoom = 1;
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    const value = getComputedStyle(current).zoom;
    const factor = value.endsWith("%") ? Number.parseFloat(value) / 100 : Number(value);
    if (Number.isFinite(factor) && factor > 0) zoom *= factor;
  }
  return zoom;
}

function isVisible(node: HTMLElement): boolean {
  if (typeof node.checkVisibility === "function")
    return node.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  // visibility 可由后代覆盖；display/content-visibility:hidden 则隐藏整个子树。
  if (getComputedStyle(node).visibility !== "visible") return false;
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === "none" || style.contentVisibility === "hidden") return false;
  }
  return node.getClientRects().length > 0;
}

/** 实例与锚点分离；普通内联与正文在同一滚动树内，不用屏幕坐标追赶滚动。 */
export function createPluginUiPagePlane(events: {
  onVisibility(visible: boolean): void;
  onCrash(): void;
}) {
  // 没有原子移动时，guest 从创建到释放始终连接唯一的窗口承载层；
  // 卡片/侧栏只交接锚点，不重挂 iframe/webview，否则 Chromium 会丢失页面状态。
  const fixedPlane = typeof Element.prototype.moveBefore !== "function";
  const anchors = new Map<symbol, { placement: SandboxPagePlacement; visible: boolean }>();
  const root = document.createElement("div");
  root.dataset.sandboxPageRoot = "true";
  root.style.display = "none";
  parkingRoot().append(root);
  let frame: HTMLElement | null = null;
  let handleId: string | null = null;
  let current: symbol | undefined;
  let stopLayout: (() => void) | undefined;
  let stopPreview: (() => void) | undefined;
  let preview: HTMLElement | null = null;
  let executionActive = false;
  let backgroundSize = { width: 640, height: 480 };
  let disposed = false,
    loaded = false,
    pluginLoaded = false,
    visible = false;
  const visibility = (next: boolean) => {
    if (next === visible) return;
    visible = next;
    events.onVisibility(next);
  };
  const move = (parent: HTMLElement) => {
    if (root.parentElement === parent) return;
    if (fixedPlane) return;
    if (!frame) parent.append(root);
    else {
      // appendChild 会触发 Electron guest 的断开重建。preload 为沙箱注册移动回调后才允许迁移。
      if (
        typeof parent.moveBefore !== "function" ||
        typeof (frame as HTMLElement & { connectedMoveCallback?: unknown })
          .connectedMoveCallback !== "function"
      )
        throw new Error("Sandbox retained moves are unavailable; restart the desktop app");
      parent.moveBefore(root, null);
    }
  };
  const resetStyle = () => {
    // webview 释放后容器仍可能覆盖错误态按钮；容器只负责定位，点击由 webview 显式接收。
    root.style.cssText =
      "display:flow-root;position:relative;width:100%;height:100%;margin:0;border:0;padding:0;overflow:hidden;pointer-events:none";
  };
  const position = (node: HTMLElement, container: HTMLElement, fixed: boolean, layer: number) => {
    const rect = node.getBoundingClientRect();
    const parent = container.getBoundingClientRect();
    const zoom = cssZoom(container);
    const planeZoom = fixedPlane ? cssZoom(root) : fixed ? 1 : zoom;
    Object.assign(root.style, {
      position: fixed ? "fixed" : "absolute",
      inset: "auto",
      zIndex: String(layer),
      top: `${fixed ? rect.top / planeZoom : (rect.top - parent.top) / zoom + container.scrollTop - container.clientTop}px`,
      left: `${fixed ? rect.left / planeZoom : (rect.left - parent.left) / zoom + container.scrollLeft - container.clientLeft}px`,
      width: `${rect.width / planeZoom}px`,
      height: `${rect.height / planeZoom}px`,
      borderRadius: getComputedStyle(node).borderRadius,
    });
  };
  const positionFixed = (node: HTMLElement, layer: number) => {
    position(node, parkingRoot(), true, layer);
    const rect = node.getBoundingClientRect();
    let top = Math.max(0, rect.top),
      left = Math.max(0, rect.left);
    let right = Math.min(window.innerWidth, rect.right);
    let bottom = Math.min(window.innerHeight, rect.bottom);
    root.style.maskImage = "none";
    root.style.webkitMaskImage = "none";
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      const zoom = cssZoom(parent);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left + parent.clientLeft * zoom);
        right = Math.min(right, bounds.left + (parent.clientLeft + parent.clientWidth) * zoom);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top + parent.clientTop * zoom);
        bottom = Math.min(bottom, bounds.top + (parent.clientTop + parent.clientHeight) * zoom);
      }
      if (parent.dataset.sandboxPageMask && style.maskImage !== "none") {
        // fixed-plane 脱离消息树后不会继承 composer mask；只投影消息 owner 的现有状态，
        // 不在页面层重复贴底判定或维护另一组 composer 高度。
        const planeZoom = cssZoom(root);
        const transparentY = parent.dataset.sandboxPageMaskTransparentY;
        if (transparentY !== undefined && Number.isFinite(Number(transparentY)))
          bottom = Math.min(bottom, bounds.top + Number(transparentY) * zoom);
        const [x = "0", y = "0"] = style.maskPosition.split(/\s+/);
        const [, height = "auto"] = style.maskSize.split(/\s+/);
        const maskPosition = `${(bounds.left - rect.left + parseFloat(x) * zoom) / planeZoom}px ${(bounds.top - rect.top + parseFloat(y) * zoom) / planeZoom}px`;
        const maskSize = `${bounds.width / planeZoom}px ${height === "auto" ? height : `${(parseFloat(height) * zoom) / planeZoom}px`}`;
        Object.assign(root.style, {
          maskImage: style.maskImage,
          webkitMaskImage: style.maskImage,
          maskPosition,
          webkitMaskPosition: maskPosition,
          maskSize,
          webkitMaskSize: maskSize,
          maskRepeat: style.maskRepeat,
          webkitMaskRepeat: style.maskRepeat,
        });
      }
    }
    const zoom = cssZoom(root);
    // 固定承载层不在原滚动树，必须显式保留其裁剪，不能覆盖正文/工具栏。
    root.style.clipPath = `inset(${Math.max(0, top - rect.top) / zoom}px ${Math.max(0, rect.right - right) / zoom}px ${Math.max(0, rect.bottom - bottom) / zoom}px ${Math.max(0, left - rect.left) / zoom}px)`;
  };
  const endPreview = () => {
    stopPreview?.();
    stopPreview = undefined;
    if (root.matches(":popover-open")) root.hidePopover();
    root.removeAttribute("popover");
    preview = null;
  };
  const track = (node: HTMLElement, update: () => void) => {
    // 承载层尺寸完全由锚点决定；反向观察承载层会在 popover 切换时形成 ResizeObserver 回环。
    const stop = autoUpdate(node, root, update, {
      elementResize: false,
      ...(fixedPlane ? { animationFrame: true } : {}),
    });
    const resize = new ResizeObserver(update);
    resize.observe(node);
    // composer 形态可只改 mask 而不移动锚点；不能仅依赖 autoUpdate 的矩形变化。
    const maskObserver =
      fixedPlane && typeof MutationObserver !== "undefined"
        ? new MutationObserver(update)
        : undefined;
    if (maskObserver)
      for (let parent = node.parentElement; parent; parent = parent.parentElement)
        if (parent.dataset.sandboxPageMask)
          maskObserver.observe(parent, {
            attributes: true,
            attributeFilter: ["style", "data-sandbox-page-mask-transparent-y"],
          });
    return () => {
      resize.disconnect();
      maskObserver?.disconnect();
      stop();
    };
  };
  const layout = () => {
    if (disposed) return;
    // forceMount 的隐藏 tab 仍连接 DOM，但尺寸为零；不能让它夺走后台初始化的承载表面。
    const candidates = [...anchors].filter(([, a]) => {
      const node = a.placement.node;
      const rect = node.getBoundingClientRect();
      return node.isConnected && isVisible(node) && rect.width > 0 && rect.height > 0;
    });
    const chosen = candidates.find(([, a]) => a.placement.kind === "sidebar") ?? candidates.at(-1);
    visibility(Boolean(chosen && (chosen[1].visible || preview)));
    if (chosen && chosen[0] === current) return;
    const bounds = root.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0)
      backgroundSize = { width: bounds.width, height: bounds.height };
    current = chosen?.[0];
    stopLayout?.();
    stopLayout = undefined;
    endPreview();
    resetStyle();
    if (!chosen) {
      move(parkingRoot());
      root.style.display = "none";
      root.inert = true;
      if (executionActive) {
        // display:none 会停止编辑器依赖的 rAF；保留的 MCP 页面始终需要可执行且不接收输入的表面。
        Object.assign(root.style, {
          display: "block",
          position: "fixed",
          top: "0",
          left: "0",
          width: `${backgroundSize.width}px`,
          height: `${backgroundSize.height}px`,
          opacity: "0.001",
        });
      }
      return;
    }
    root.inert = false;
    const { node, kind, container, layer = 10 } = chosen[1].placement;
    const parent = kind === "sidebar" ? parkingRoot() : (container ?? node);
    move(parent);
    if (fixedPlane || (kind !== "flow" && parent !== node))
      stopLayout = track(node, () => {
        if (fixedPlane && preview) return;
        const rect = node.getBoundingClientRect();
        if (!isVisible(node) || !rect.width || !rect.height) {
          layout();
          return;
        }
        if (fixedPlane) positionFixed(node, layer);
        else position(node, parent, kind === "sidebar", layer);
      });
  };
  const intersection = new IntersectionObserver((entries) => {
    for (const entry of entries)
      for (const a of anchors.values())
        if (a.placement.node === entry.target) a.visible = entry.isIntersecting;
    layout();
  });
  const ready = () => {
    loaded = true;
  };
  const frameReady = (event: Event) => {
    if (!(event as Event & { isMainFrame?: boolean }).isMainFrame) pluginLoaded = true;
  };
  const navigation = (event: Event) => {
    const nav = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
    if (!nav.isInPlace && ((loaded && nav.isMainFrame) || (pluginLoaded && !nav.isMainFrame)))
      events.onCrash();
  };
  const prepareUnmount = (expectedId?: string) => {
    if (expectedId && expectedId !== handleId) return;
    frame?.removeEventListener("render-process-gone", events.onCrash);
    frame?.removeEventListener("dom-ready", ready);
    frame?.removeEventListener("did-start-navigation", navigation);
    frame?.removeEventListener("did-frame-finish-load", frameReady);
    loaded = false;
    pluginLoaded = false;
  };
  const unmount = (expectedId?: string) => {
    if (expectedId && expectedId !== handleId) return;
    prepareUnmount(expectedId);
    frame?.remove();
    frame = null;
    handleId = null;
  };
  return {
    setExecutionActive(active: boolean) {
      if (executionActive === active) return;
      executionActive = active;
      layout();
    },
    bind(placement: SandboxPagePlacement) {
      const token = Symbol();
      anchors.set(token, { placement, visible: true });
      intersection.observe(placement.node);
      layout();
      return () => {
        anchors.delete(token);
        if (![...anchors.values()].some((a) => a.placement.node === placement.node))
          intersection.unobserve(placement.node);
        // 必须同步迁移，再让 React 删除锚点；不能放到 RAF / passive effect。
        layout();
      };
    },
    preview(node: HTMLElement | null) {
      endPreview();
      resetStyle();
      if (!node) {
        current = undefined;
        layout();
        return;
      }
      preview = node;
      root.setAttribute("popover", "manual");
      root.showPopover();
      const update = () => position(node, document.documentElement, true, 45);
      stopPreview = track(node, update);
      visibility(true);
    },
    captureBounds(gutter = 0) {
      if (!frame || !visible) throw new Error("Sandbox is not visible");
      const rect = frame.getBoundingClientRect();
      return {
        viewportSize: { width: rect.width, height: rect.height },
        captureRect: {
          x: gutter,
          y: gutter,
          width: rect.width - gutter * 2,
          height: rect.height - gutter * 2,
        },
      };
    },
    focus() {
      frame?.focus();
    },
    mount(handle: PluginSandboxHandle) {
      if (handleId === handle.sandboxId) return;
      unmount();
      handleId = handle.sandboxId;
      frame = document.createElement("webview");
      frame.setAttribute("data-zcode-retained-sandbox", "");
      frame.setAttribute("src", handle.shellUrl);
      frame.setAttribute("partition", handle.partition);
      frame.setAttribute("data-testid", "plugin-ui-webview");
      frame.style.cssText =
        "display:flex;width:100%;height:100%;border:0;background:transparent;pointer-events:auto";
      frame.addEventListener("render-process-gone", events.onCrash);
      frame.addEventListener("dom-ready", ready);
      frame.addEventListener("did-frame-finish-load", frameReady);
      frame.addEventListener("did-start-navigation", navigation);
      root.append(frame);
    },
    prepareUnmount,
    unmount,
    dispose() {
      disposed = true;
      endPreview();
      stopLayout?.();
      unmount();
      intersection.disconnect();
      anchors.clear();
      root.remove();
    },
  };
}
