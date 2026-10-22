import { afterEach, expect, it, vi } from "vitest";
import { createPluginUiPagePlane } from "./pluginUiPagePlane.js";

vi.mock("@floating-ui/dom", () => ({
  autoUpdate: (_anchor: unknown, _root: unknown, update: () => void) => {
    update();
    return () => undefined;
  },
}));

afterEach(() => vi.unstubAllGlobals());

it("keeps the loaded guest connected while flow, sidebar, preview and parking exchange ownership", () => {
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
  const observer = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.stubGlobal("Element", Node);
  vi.stubGlobal("ResizeObserver", observer);
  vi.stubGlobal("IntersectionObserver", observer);
  vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
  vi.stubGlobal("getComputedStyle", () => ({
    zoom: "1",
    visibility: "visible",
    display: "block",
    contentVisibility: "visible",
    overflowX: "visible",
    overflowY: "visible",
    borderRadius: "0px",
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
    instance: { runtimeId: "runtime", generation: 1, appIdentity: "a".repeat(64), token: "token" },
    sandboxId: "same-guest",
    initId: 1,
    shellUrl: "zcode-plugin://shell",
    partition: "plugin",
  });
  const parking = body.children[0]!;
  const root = parking.children[0]!;
  const guest = root.children[0]!;
  guest.listeners.get("dom-ready")?.({});
  const flow = new Node(),
    sidebar = new Node();
  body.append(flow);
  body.append(sidebar);
  const unbindFlow = plane.bind({ node: flow as unknown as HTMLElement, kind: "flow" });
  const unbindSidebar = plane.bind({ node: sidebar as unknown as HTMLElement, kind: "sidebar" });
  unbindSidebar();
  sidebar.remove();
  plane.preview(flow as unknown as HTMLElement);
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
});
