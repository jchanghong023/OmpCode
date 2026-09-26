// GUI 操作：打开模型下拉并选择第一个免费模型（真实鼠标点击路径）。
import { appendFileSync } from "node:fs";

const TEE = "C:/Users/jiang/AppData/Local/Temp/omp-gui-actions.log";
const log = (msg) => {
  console.log(msg);
  appendFileSync(TEE, msg + "\n");
};

async function main() {
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
      pending.set(id, (m) =>
        m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) => {
    const r = await call("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };
  const click = async (x, y) => {
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  };

  const info = await ev(`(() => {
    const els = [...document.querySelectorAll('button, [role=combobox], [role=button]')];
    const trigger = els.find(el => (el.textContent||'').includes('选择模型'));
    if (!trigger) return { found: false };
    const r = trigger.getBoundingClientRect();
    return { found: true, x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  log("trigger: " + JSON.stringify(info));
  if (!info.found) {
    ws.close();
    return;
  }
  await click(info.x, info.y);
  await new Promise((s) => setTimeout(s, 1500));
  const options = await ev(`(() => {
    const items = [...document.querySelectorAll('[role=option], [role=menuitem], [cmdk-item], [data-radix-collection-item]')];
    return items.map(el => ({ text: (el.textContent||'').trim().slice(0, 60), rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), visible: r.width > 0 && r.height > 0 }; })() })).filter(o => o.text && o.rect.visible).slice(0, 12);
  })()`);
  log("options: " + JSON.stringify(options));
  const preferred = options.find((o) => /free/i.test(o.text)) ?? options[0];
  if (preferred) {
    log("picking: " + preferred.text);
    await click(preferred.rect.x, preferred.rect.y);
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
    log("selected: " + sel);
  }
  ws.close();
}

main().catch((e) => {
  log("FAILED: " + e.message);
  process.exit(1);
});
