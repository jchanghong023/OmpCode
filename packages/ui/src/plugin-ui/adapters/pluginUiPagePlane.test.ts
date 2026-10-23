import { afterEach, expect, it, vi } from "vitest";
import { createPluginUiPagePlane } from "./pluginUiPagePlane.js";

vi.mock("@floating-ui/dom", () => ({
  autoUpdate: (_anchor: unknown, _root: unknown, update: () => void) => {
    update();
    return () => undefined;
  },
}));

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "keeps guest state and message masks across placements (moveBefore: %s)",
  (atomicMove) => {
    class Node {
      dataset: Record<string, string> = {};
      style: Record<string, string> = {};
      parentElement: Node | null = null;
      children: Node[] = [];
      attributes = new Map<string, string>();
      listeners = new Map<string, (event: object) => void>();
      disconnects = 0;
      inert = false;
      scrollTop = 0;
      scrollLeft = 0;
      clientTop = 0;
      clientLeft = 0;
      clientWidth = 300;
      clientHeight = 200;
      constructor() {
        Object.defineProperty(this.style, "cssText", {
          set: () => {
            for (const key of Object.keys(this.style)) delete this.style[key];
          },
        });
      }
      get isConnected(): boolean {
        return this === body || this.parentElement?.isConnected === true;
      }
      append(node: Node) {
        if (node.parentElement) node.remove();
        node.parentElement = this;
        this.children.push(node);
      }
      remove() {
        if (this.isConnected) this.disconnects++;
        if (this.parentElement)
          this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
        this.parentElement = null;
      }
      getBoundingClientRect() {
        return { top: 20, left: 10, width: 300, height: 200, right: 310, bottom: 220 };
      }
      getClientRects() {
        return [this.getBoundingClientRect()];
      }
      setAttribute(key: string, value: string) {
        this.attributes.set(key, value);
      }
      removeAttribute(key: string) {
        this.attributes.delete(key);
      }
      matches() {
        return false;
      }
      showPopover() {}
      hidePopover() {}
      addEventListener(name: string, handler: (event: object) => void) {
        this.listeners.set(name, handler);
      }
      removeEventListener(name: string) {
        this.listeners.delete(name);
      }
    }
    const body = new Node();
    if (atomicMove)
      Object.assign(Node.prototype, {
        moveBefore(this: Node, node: Node) {
          if (node.parentElement)
            node.parentElement.children = node.parentElement.children.filter(
              (child) => child !== node,
            );
          node.parentElement = this;
          this.children.push(node);
        },
      });
    const observer = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    vi.stubGlobal("Element", Node);
    vi.stubGlobal("ResizeObserver", observer);
    vi.stubGlobal("IntersectionObserver", observer);
    let updateMask: (() => void) | undefined;
    let maskAttributes: string[] | undefined;
    vi.stubGlobal(
      "MutationObserver",
      class extends observer {
        constructor(update: () => void) {
          super();
          updateMask = update;
        }
        observe(_node?: Node, options?: { attributeFilter: string[] }) {
          maskAttributes = options?.attributeFilter;
        }
      },
    );
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
    vi.stubGlobal("getComputedStyle", (node: Node) => ({
      zoom: "1",
      visibility: "visible",
      display: "block",
      contentVisibility: "visible",
      overflowX: "visible",
      overflowY: "visible",
      borderRadius: "0px",
      maskImage: "none",
      maskPosition: "0px 0px",
      maskSize: "auto",
      maskRepeat: "repeat",
      ...node.style,
    }));
    vi.stubGlobal("document", {
      body,
      documentElement: body,
      createElement: () => new Node(),
      querySelector: () => body.children.find((node) => node.dataset.sandboxPageParking),
    });
    const onCrash = vi.fn();
    const plane = createPluginUiPagePlane({ onCrash, onVisibility: vi.fn() });
    plane.mount({
      instance: {
        runtimeId: "runtime",
        generation: 1,
        appIdentity: "a".repeat(64),
        token: "token",
      },
      sandboxId: "same-guest",
      initId: 1,
      shellUrl: "zcode-plugin://shell",
      partition: "plugin",
    });
    const parking = body.children[0]!;
    const root = parking.children[0]!;
    const guest = root.children[0]!;
    guest.listeners.get("dom-ready")?.({});
    Object.assign(guest, { connectedMoveCallback() {} });
    // 模拟虚拟历史消息层的真实遮罩；页面不能另算 composer 的排除高度。
    const messages = new Node();
    messages.dataset.sandboxPageMask = "true";
    messages.dataset.sandboxPageMaskTransparentY = "190";
    messages.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      width: 900,
      height: 600,
      right: 900,
      bottom: 600,
    });
    Object.assign(messages.style, {
      maskImage: "linear-gradient(to bottom, black 0px, transparent 150px)",
      maskPosition: "0px 40px",
      maskSize: "100% 180px",
      maskRepeat: "no-repeat",
    });
    body.append(messages);
    const flow = new Node(),
      sidebar = new Node();
    messages.append(flow);
    body.append(sidebar);
    const unbindFlow = plane.bind({ node: flow as unknown as HTMLElement, kind: "flow" });
    if (!atomicMove) {
      expect(root.style.maskImage).toBe(messages.style.maskImage);
      expect(root.style.maskPosition).toBe("-10px 20px");
      expect(root.style.maskSize).toBe("900px 180px");
      expect(root.style.maskRepeat).toBe("no-repeat");
      // CSS mask 不参与命中测试；完全透明区必须同时被几何裁剪。
      expect(root.style.clipPath).toBe("inset(0px 0px 30px 0px)");
      expect(maskAttributes).toEqual(["style", "data-sandbox-page-mask-transparent-y"]);
      messages.dataset.sandboxPageMaskTransparentY = "180";
      updateMask?.();
      expect(root.style.clipPath).toBe("inset(0px 0px 40px 0px)");
      // 消息滚动后边界仍是 owner 本地 CSS 坐标，由实时 rect 投影。
      messages.getBoundingClientRect = () => ({
        top: -20,
        left: 0,
        width: 900,
        height: 600,
        right: 900,
        bottom: 580,
      });
      updateMask?.();
      expect(root.style.clipPath).toBe("inset(0px 0px 60px 0px)");
      messages.style.zoom = "2";
      messages.getBoundingClientRect = () => ({
        top: -160,
        left: 0,
        width: 1800,
        height: 1200,
        right: 1800,
        bottom: 1040,
      });
      updateMask?.();
      expect(root.style.clipPath).toBe("inset(0px 0px 20px 0px)");
      // 贴底/浮窗只修改消息 owner 的 mask，锚点不动时也必须立即跟随。
      messages.style.maskImage = "none";
      updateMask?.();
      expect(root.style.maskImage).toBe("none");
      expect(root.style.clipPath).toBe("inset(0px 0px 0px 0px)");
      delete messages.dataset.sandboxPageMaskTransparentY;
      expect(updateMask).toBeDefined();
      messages.style.maskImage = "linear-gradient(to bottom, black 0px, transparent 150px)";
      updateMask?.();
      expect(root.style.clipPath).toBe("inset(0px 0px 0px 0px)");
      messages.dataset.sandboxPageMaskTransparentY = "180";
      updateMask?.();
      expect(root.style.clipPath).toBe("inset(0px 0px 20px 0px)");
      expect(root.style.maskImage).toBe(messages.style.maskImage);
    }
    const unbindSidebar = plane.bind({ node: sidebar as unknown as HTMLElement, kind: "sidebar" });
    if (!atomicMove) {
      expect(getComputedStyle(root as unknown as HTMLElement).maskImage).toBe("none");
      expect(root.style.clipPath).toBe("inset(0px 0px 0px 0px)");
    }
    unbindSidebar();
    sidebar.remove();
    plane.preview(flow as unknown as HTMLElement);
    if (!atomicMove) {
      expect(getComputedStyle(root as unknown as HTMLElement).maskImage).toBe("none");
      expect(root.style.clipPath).toBeUndefined();
    }
    plane.preview(null);
    unbindFlow();
    flow.remove();
    plane.setExecutionActive(true);
    expect(root.parentElement).toBe(parking);
    expect(guest.parentElement).toBe(root);
    expect(guest.isConnected).toBe(true);
    expect(root.disconnects).toBe(0);
    expect(guest.disconnects).toBe(0);
    expect(onCrash).not.toHaveBeenCalled();
    plane.dispose();
    expect(guest.isConnected).toBe(false);
  },
);
