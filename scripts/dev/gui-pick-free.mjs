// 选择 commandcode 分组下的 ling free 模型（scrollIntoView + 真实点击）。
const targets = await fetch("http://127.0.0.1:9230/json/list").then((r) => r.json());
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expr) => {
  const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const click = async (x, y) => {
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};

const all = await ev(`(() => {
  const items = [...document.querySelectorAll('[role=option],[role=menuitem],[cmdk-item],[data-radix-collection-item]')].filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().x > 500);
  return items.map(el => (el.textContent||'').trim().slice(0, 60));
})()`);
console.log("面板条目:", JSON.stringify(all).slice(0, 600));

const result = await ev(`(() => {
  const items = [...document.querySelectorAll('[role=option],[role=menuitem],[cmdk-item],[data-radix-collection-item]')];
  const free = items.find(el => /free/i.test(el.textContent||'') && (el.textContent||'').includes('ling'));
  if (!free) return 'not-found';
  free.scrollIntoView({ block: 'center' });
  return 'scrolled';
})()`);
console.log(result);
await new Promise((s) => setTimeout(s, 500));
const rect = await ev(`(() => {
  const items = [...document.querySelectorAll('[role=option],[role=menuitem],[cmdk-item],[data-radix-collection-item]')];
  const free = items.find(el => /free/i.test(el.textContent||'') && (el.textContent||'').includes('ling') && el.getBoundingClientRect().width > 0);
  if (!free) return null;
  const r = free.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: free.textContent.trim().slice(0, 50) };
})()`);
console.log("rect:", JSON.stringify(rect));
if (rect) {
  await click(rect.x, rect.y);
  await new Promise((s) => setTimeout(s, 1000));
  const sel = await ev(`(() => {
    const el = document.querySelector('[data-testid=v4-composer-send]');
    const key = el && Object.keys(el).find(k => k.startsWith('__reactFiber'));
    let fiber = el && el[key];
    let hops = 0;
    while (fiber && hops < 60) {
      const p = fiber.memoizedProps;
      if (p && typeof p === 'object' && 'draftConfig' in p) {
        return p.draftConfig && p.draftConfig.modelSelection ? p.draftConfig.modelSelection.providerId + '/' + p.draftConfig.modelSelection.modelId : null;
      }
      fiber = fiber.return; hops += 1;
    }
    return 'no-props';
  })()`);
  console.log("selected:", sel);
}
ws.close();
