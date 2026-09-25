// 一次完成：打开模型下拉 → commandcode 分组 → 滚动到 Ling 3.0 Flash Sante → 点击。
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
const getSelection = () =>
  ev(`(() => {
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

// 打开下拉
const trigger = await ev(`(() => {
  const t = [...document.querySelectorAll('button,[role=combobox]')].find(el => (el.textContent||'').includes('选择模型'));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
})()`);
console.log("trigger:", JSON.stringify(trigger));
if (!trigger) process.exit(1);
await click(trigger.x, trigger.y);
await new Promise((s) => setTimeout(s, 1200));

// 点 commandcode 分组
const grp = await ev(`(() => {
  const items = [...document.querySelectorAll('[role=option],[role=menuitem],[cmdk-item],[data-radix-collection-item]')].filter(el => el.getBoundingClientRect().width > 0);
  const g = items.find(el => (el.textContent||'').trim() === 'commandcode');
  if (!g) return null;
  const r = g.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
})()`);
console.log("group:", JSON.stringify(grp));
if (!grp) process.exit(1);
await click(grp.x, grp.y);
await new Promise((s) => setTimeout(s, 1200));

// scrollIntoView + click Ling
const scrolled = await ev(`(() => {
  const items = [...document.querySelectorAll('[role=option],[role=menuitem],[cmdk-item],[data-radix-collection-item]')];
  const t = items.find(el => (el.textContent||'').trim() === 'Ling 3.0 Flash Sante');
  if (!t) return 'not-found';
  t.scrollIntoView({ block: 'center' });
  return 'scrolled';
})()`);
console.log(scrolled);
await new Promise((s) => setTimeout(s, 700));
const rect = await ev(`(() => {
  const items = [...document.querySelectorAll('[role=option],[role=menuitem],[cmdk-item],[data-radix-collection-item]')].filter(el => el.getBoundingClientRect().width > 0);
  const t = items.find(el => (el.textContent||'').trim() === 'Ling 3.0 Flash Sante');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
})()`);
console.log("rect:", JSON.stringify(rect));
if (!rect || rect.y < 60 || rect.y > 1140) {
  console.log("FAILED: target off-viewport");
  process.exit(1);
}
await click(rect.x, rect.y);
await new Promise((s) => setTimeout(s, 1200));
console.log("selected:", await getSelection());
ws.close();
