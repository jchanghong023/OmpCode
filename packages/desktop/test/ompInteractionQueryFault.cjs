// Fixture-only specification: a single owned Host delivers one malformed interaction query
// to its unchanged RPC service. Only sessionId's encoded value changes; ports, request IDs,
// callbacks and production replies retain their real owners. This is not crash recovery.
const assert = require("node:assert/strict");
const { readFileSync, renameSync, writeFileSync } = require("node:fs");
const { isAbsolute, join, relative, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

function files(root) {
  assert.ok(root && isAbsolute(root), "Interaction fault requires an absolute owned root");
  return {
    owner: join(root, "evidence", "interaction-query-owner.json"),
    control: join(root, "evidence", "interaction-query-control.json"),
    receipt: (pid) => join(root, "evidence", `interaction-query-${pid}.json`),
  };
}
function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Decode only the existing RPC header and the targeted JSON/array body. Never re-encode
// unrelated packets (including binary archives and flow-control objects).
function packet(bytes, bodyRequired = false) {
  if (!(bytes instanceof Uint8Array)) return null;
  let offset = 0;
  const integer = () => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      assert.ok(offset < bytes.length);
      const next = bytes[offset++];
      value |= (next & 127) << shift;
      if (!(next & 128)) return value;
    }
    throw new Error("Invalid fixture RPC integer");
  };
  const read = () => {
    assert.ok(offset < bytes.length);
    const type = bytes[offset++];
    if (type === 0) return undefined;
    if (type === 6) return integer();
    if (type === 4) return Array.from({ length: integer() }, read);
    assert.ok(type === 1 || type === 5);
    const length = integer();
    const start = offset;
    offset += length;
    assert.ok(offset <= bytes.length);
    const text = Buffer.from(bytes.buffer, bytes.byteOffset + start, length).toString("utf8");
    return type === 1 ? text : JSON.parse(text);
  };
  try {
    const header = read();
    if (!Array.isArray(header)) return null;
    const bodyStart = offset;
    return { header, body: bodyRequired ? read() : undefined, bodyStart };
  } catch {
    return null;
  }
}

// 数据隔离（FORK.md）：产品数据根不看显式 ZCODE_DATA_BASE_DIR——services getDataBaseDir() 优先返回
// OMP_CONFIG_ROOT 派生的 `<OMP_CONFIG_ROOT>_ompcode`（packages/shared/src/node/ompPaths.ts
// resolveOmpCodePersistentRoot，经 packages/desktop/src/main/OmpDesktopDataPaths.ts 生效），
// 启动器已清空 OMP_OFFLINE，因此不存在 Linux shm 分支。
// 本 .cjs 无法同步复用该 TS 派生函数（shared 包的 exports 指向 src/*.ts），
// 只能按同一规则从注入的 env 推导期望根：断言 intent 不变，故障注入必须落在本次沙箱自己的数据根。
function derivedDataRoot(root, env) {
  const configRoot = env.OMP_CONFIG_ROOT?.trim();
  assert.ok(
    configRoot && isAbsolute(configRoot),
    "Interaction fault requires the fixture's absolute OMP config root",
  );
  const expected = `${resolve(configRoot)}_ompcode`;
  const local = relative(root, expected);
  assert.ok(
    local && !local.startsWith("..") && !isAbsolute(local),
    `Derived data root ${expected} must stay inside this fixture`,
  );
  return expected;
}

function installHost() {
  const root = process.env.OMP_E2E_ISOLATED_ROOT;
  const paths = files(root);
  const owner = json(paths.owner);
  assert.equal(owner.root, root);
  assert.equal(owner.electronPid, process.ppid, "Only the fixture's direct Host may inject");
  assert.equal(owner.nonce, process.env.OMP_E2E_INTERACTION_FAULT_NONCE);
  assert.equal(
    resolve(process.env.ZCODE_DATA_BASE_DIR),
    derivedDataRoot(root, process.env),
    "Inject only into this fixture's own Host data root",
  );
  assert.ok(process.parentPort?.prependListener, "Observe actual transferred Host ports");
  const state = { root, nonce: owner.nonce, hostPid: process.pid, queries: 0, replies: [] };
  const save = () => {
    const target = paths.receipt(process.pid);
    writeFileSync(`${target}.next`, JSON.stringify(state));
    renameSync(`${target}.next`, target);
  };
  const ports = new WeakSet();
  const consumed = new Set();
  save();
  // 不能自己抢注 parentPort 的 message 监听：ParentPort 把注册前积压的消息只投递给“注册那一刻”的监听者，
  // 抢先注册会让宿主自己的监听者永远收不到 InitLocal（实测 Electron 44.4.5）。因此只包装宿主的注册入口，
  // 在宿主处理每条消息之前插入端口拦截。
  const observe = (event) => {
    for (const port of event.ports ?? []) {
      if (ports.has(port)) continue;
      ports.add(port);
      const pending = new Map();
      port.prependListener("message", (message) => {
        const parsed = packet(message.data);
        if (
          parsed?.header[0] !== 100 ||
          parsed.header[2] !== "zcode-agent" ||
          parsed.header[3] !== "listSessionAgentInteractions"
        )
          return;
        const query = packet(message.data, true);
        if (!query || !Array.isArray(query.body) || query.body.length !== 1) return;
        const params = query.body[0];
        if (
          typeof params?.workspacePath !== "string" ||
          resolve(params.workspacePath) !== resolve(root, "workspace")
        )
          return;
        state.queries++;
        const control = json(paths.control);
        assert.equal(control.root, root);
        assert.equal(control.nonce, owner.nonce);
        let faultToken = null;
        if (
          control.armed &&
          control.hostPid === process.pid &&
          params.sessionId === control.sessionId &&
          !consumed.has(control.token)
        ) {
          const bytes = message.data;
          const body = Buffer.from(
            bytes.buffer,
            bytes.byteOffset + query.bodyStart,
            bytes.byteLength - query.bodyStart,
          );
          const field = Buffer.from(`"sessionId":${JSON.stringify(params.sessionId)}`);
          const fieldAt = body.indexOf(field);
          assert.ok(fieldAt >= 0 && body.indexOf(field, fieldAt + 1) === -1);
          const start = fieldAt + Buffer.byteLength('"sessionId":');
          const length = field.length - Buffer.byteLength('"sessionId":');
          assert.ok(length >= 4);
          // Same Uint8Array/byte length and same transfer object: invalidate only this value.
          body.fill(32, start, start + length);
          body.write("null", start, "utf8");
          faultToken = control.token;
          consumed.add(faultToken);
          state.injected = {
            token: faultToken,
            requestId: query.header[1],
            sessionId: params.sessionId,
          };
        }
        pending.set(query.header[1], { faultToken, sessionId: params.sessionId });
        save();
      });
      const postMessage = port.postMessage;
      port.postMessage = function (...args) {
        const response = packet(args[0]);
        const request = response && pending.get(response.header[1]);
        if (request && [201, 202, 203].includes(response.header[0])) {
          const reply = packet(args[0], true);
          pending.delete(response.header[1]);
          state.replies.push({
            requestId: response.header[1],
            faultToken: request.faultToken,
            sessionId: request.sessionId,
            type: response.header[0],
            ...(response.header[0] === 201
              ? {
                  rootSessionId: reply?.body?.rootSessionId,
                  eventCount: reply?.body?.events?.length,
                  totalEvents: reply?.body?.totalEvents,
                }
              : {}),
          });
          save();
        }
        return postMessage.apply(this, args);
      };
    }
  };
  for (const method of ["on", "addListener", "once", "prependListener"]) {
    const register = process.parentPort[method].bind(process.parentPort);
    process.parentPort[method] = (event, listener) =>
      register(
        event,
        event === "message" ? (message) => (observe(message), listener(message)) : listener,
      );
  }
}

function ownedHostUtilityProcess(utilityProcess, { root, hostPath, nonce }) {
  const paths = files(root);
  const hosts = new Set();
  writeFileSync(paths.owner, JSON.stringify({ root, electronPid: process.pid, nonce }));
  writeFileSync(paths.control, JSON.stringify({ root, nonce, armed: false }));
  const proxy = new Proxy(utilityProcess, {
    get(target, name) {
      if (name !== "fork") return Reflect.get(target, name);
      return (modulePath, args, options) => {
        if (resolve(modulePath) !== resolve(hostPath))
          return target.fork(modulePath, args, options);
        assert.equal(options.env.OMP_E2E_ISOLATED_ROOT, root);
        // Electron 44 的 utilityProcess 不执行 execArgv 里的 --require（只有宿主内部的 worker 线程会重放
        // execArgv，导致注入模块在 worker 里误判并抛错），因此改为把 fork 目标换成本模块：
        // 宿主主线程先安装端口拦截，再动态加载真实宿主入口（OMP_E2E_INTERACTION_HOST_ENTRY）。
        const child = target.fork(__filename, args, {
          ...options,
          env: {
            ...options.env,
            OMP_E2E_INTERACTION_FAULT_NONCE: nonce,
            OMP_E2E_INTERACTION_HOST_ENTRY: hostPath,
          },
        });
        child.once("spawn", () => hosts.add(child.pid));
        return child;
      };
    },
  });
  return {
    utilityProcess: proxy,
    observations() {
      const receipts = [...hosts].flatMap((pid) => {
        try {
          const receipt = json(paths.receipt(pid));
          assert.equal(receipt.root, root);
          assert.equal(receipt.nonce, nonce);
          return [receipt];
        } catch (error) {
          if (error.code === "ENOENT") return [];
          throw error;
        }
      });
      return {
        agentInteractionQueries: receipts.reduce((total, receipt) => total + receipt.queries, 0),
        interactionQueryHosts: receipts,
      };
    },
  };
}

// 宿主入口角色：本模块被当作 utilityProcess 入口 fork 时，先安装端口拦截，再加载真实宿主入口。
// 真实入口是 ESM bundle（packages/desktop/out/host/index.js，package type=module），只能动态 import；
// 宿主自身的事件循环会保持进程存活，因此不需要 await。
if (process.env.OMP_E2E_INTERACTION_HOST_ENTRY) {
  installHost();
  const entry = process.env.OMP_E2E_INTERACTION_HOST_ENTRY;
  assert.ok(isAbsolute(entry), "Interaction fault requires an absolute Host entry");
  void import(pathToFileURL(entry).href).catch((error) => {
    console.error("[omp-e2e-interaction-fault] failed to load the real Host entry", error);
    process.exitCode = 1;
  });
}
module.exports = { ownedHostUtilityProcess };
