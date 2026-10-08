import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceConfigLoader } from "../src/adapters/workspaceConfig.js";
import { OmpDirectoryGateway } from "../src/adapters/ompDirectoryGateway.js";
import type {
  OmpDirectoryGatewayPort,
  OmpProcessFactory,
  OmpSessionProcess,
} from "../src/app/ports.js";
import type { OmpCommandFrame } from "../src/domain/ompFrames.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";

function loaderWith(send: OmpDirectoryGatewayPort["send"]) {
  const directory: OmpDirectoryGatewayPort = { ...createDirectoryStub(), send };
  return createWorkspaceConfigLoader(".", { directory });
}

test("聚合目录的命令失败仅降级命令，保留真实模型候选和当前选择", async () => {
  for (const transportFailure of [false, true]) {
    const loader = loaderWith(async (command) => {
      switch (command.type) {
        case "get_available_commands":
          if (transportFailure) throw new Error("command transport failed");
          return { success: false, error: "command catalog failed" };
        case "get_available_models":
          return {
            success: true,
            data: { models: [{ provider: "smoke", id: "one", name: "Smoke One" }] },
          };
        case "get_available_thinking_levels":
          return { success: true, data: { levels: ["off", "high"] } };
        case "get_state":
          return {
            success: true,
            data: { model: { provider: "smoke", id: "one" }, thinkingLevel: "high" },
          };
        default:
          throw new Error("unexpected directory command");
      }
    });
    const config = await loader.loadWorkspaceConfig();
    assert.equal(config.slashCommands.length, 0);
    const model = config.configOptions.find((option) => option.id === "model");
    assert.ok(model && "options" in model && Array.isArray(model.options));
    assert.equal(model.currentValue, "smoke/one");
    assert.deepEqual(
      model.options.map((option) => option.value),
      ["smoke/one"],
    );
    const thought = config.configOptions.find((option) => option.id === "thought_level");
    assert.ok(thought && "options" in thought && Array.isArray(thought.options));
    assert.equal(thought.currentValue, "high");
    assert.deepEqual(
      thought.options.map((option) => option.value),
      ["off", "high"],
    );
  }
});

test("无账号的合法空模型目录不阻塞空命令或正常扩展命令展示", async () => {
  for (const commands of [
    [],
    [{ name: "hello-ext", source: "extension", description: "Local editor" }],
  ]) {
    const loader = loaderWith(async (command) => ({
      success: true,
      data:
        command.type === "get_available_commands"
          ? { commands }
          : command.type === "get_available_models"
            ? { models: [] }
            : command.type === "get_available_thinking_levels"
              ? { levels: [] }
              : {},
    }));
    const config = await loader.loadWorkspaceConfig();
    assert.deepEqual(
      config.slashCommands.map((command) => command.name),
      commands.map((command) => command.name),
    );
    const model = config.configOptions.find((option) => option.id === "model");
    assert.ok(model && "options" in model && Array.isArray(model.options));
    assert.equal(model.options.length, 0);
  }
});

function controlledDirectoryProcesses(forkSurface = true) {
  const instances: {
    releaseStart: () => void;
    exit: (code: number | null) => void;
    update: (commands: unknown) => void;
    sent: OmpCommandFrame[];
    process: OmpSessionProcess;
    starts: number;
    disposals: number;
  }[] = [];
  const factory: OmpProcessFactory = {
    create(options) {
      assert.equal(options.sessionless, true);
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const instance = {
        releaseStart,
        exit: options.onExit,
        update: (commands: unknown) => options.onCommandsUpdate?.(commands),
        sent: [] as OmpCommandFrame[],
        process: null as unknown as OmpSessionProcess,
        starts: 0,
        disposals: 0,
      };
      instance.process = {
        ompSessionFile: null,
        forkSurface,
        async start() {
          instance.starts += 1;
          await startGate;
        },
        async send(command) {
          instance.sent.push(command);
          return {
            success: true,
            data:
              command.type === "get_available_commands"
                ? { commands: [{ name: "current", source: "extension" }] }
                : {},
          };
        },
        respondUi() {},
        async refreshState() {
          return null;
        },
        async readContextReport() {
          return null;
        },
        async dispose() {
          instance.disposals += 1;
        },
      };
      instances.push(instance);
      return instance.process;
    },
  };
  return { factory, instances };
}

test("目录启动收尾 exit 使共享查询暂不可用，后续新代重建且旧回调不能清新代", async (context) => {
  const { factory, instances } = controlledDirectoryProcesses();
  const updates: unknown[] = [];
  const directory = new OmpDirectoryGateway({
    cwd: ".",
    ompFactory: factory,
    onCommandsUpdate: (commands) => updates.push(commands),
  });
  context.after(() => directory.dispose());
  const query = directory.sendDirectory({ type: "get_model_roles" });
  const availability = directory.availability();
  assert.equal(instances.length, 1);
  const old = instances[0]!;
  old.exit(1);
  assert.equal((await query).code, "omp_directory_unavailable");
  assert.equal(await availability, "unavailable");
  assert.deepEqual(old.sent, []);
  assert.equal(old.disposals, 1);

  // 旧 start 仍悬挂：exit 不能等它收尾才允许下一次用户查询。
  const next = directory.sendDirectory({ type: "get_model_roles" });
  assert.equal(instances.length, 2);
  const current = instances[1]!;
  current.releaseStart();
  assert.equal((await next).success, true);
  old.releaseStart();
  old.exit(1);
  old.update([{ name: "stale" }]);
  current.update([{ name: "current" }]);
  assert.deepEqual(updates, [[{ name: "current" }]]);
  assert.equal(await directory.availability(), "available");
  assert.equal((await directory.send({ type: "get_available_commands" })).success, true);
  assert.equal(instances.length, 2);
  assert.deepEqual(old.sent, []);
  assert.deepEqual(
    current.sent.map((command) => command.type),
    ["get_model_roles", "get_available_commands"],
  );
});

test("工作区目录加载与并发 v3 查询共享正常启动，完成后复用唯一进程", async (context) => {
  const { factory, instances } = controlledDirectoryProcesses();
  const directory = new OmpDirectoryGateway({ cwd: ".", ompFactory: factory });
  context.after(() => directory.dispose());
  const loader = createWorkspaceConfigLoader(".", { directory });
  const config = loader.loadWorkspaceConfig();
  const roles = directory.sendDirectory({ type: "get_model_roles" });
  const availability = directory.availability();
  assert.equal(instances.length, 1);
  const current = instances[0]!;
  assert.equal(current.starts, 1);
  assert.deepEqual(current.sent, []);
  current.releaseStart();
  assert.equal((await roles).success, true);
  assert.equal(await availability, "available");
  assert.deepEqual(
    (await config).slashCommands.map((command) => command.name),
    ["current"],
  );
  assert.equal((await directory.send({ type: "get_available_commands" })).success, true);
  assert.equal(instances.length, 1);
  assert.equal(current.starts, 1);
});

test("存活旧核保留 unsupported 三态及 v1 目录，不伪装暂不可用", async (context) => {
  const { factory, instances } = controlledDirectoryProcesses(false);
  const directory = new OmpDirectoryGateway({ cwd: ".", ompFactory: factory });
  context.after(() => directory.dispose());
  const availability = directory.availability();
  const current = instances[0]!;
  current.releaseStart();
  assert.equal(await availability, "unsupported");
  assert.equal(
    (await directory.sendDirectory({ type: "get_model_roles" })).code,
    "omp_capability_missing",
  );
  assert.equal((await directory.send({ type: "get_available_commands" })).success, true);
  assert.deepEqual(
    current.sent.map((command) => command.type),
    ["get_available_commands"],
  );
  assert.equal(instances.length, 1);
});

test("目录启动异常保持既有退避，不在一次查询中无界重启", async (context) => {
  const { factory, instances } = controlledDirectoryProcesses();
  const failingFactory: OmpProcessFactory = {
    create(options) {
      const process = factory.create(options);
      return {
        ...process,
        async start() {
          throw new Error("startup negotiation failed");
        },
      };
    },
  };
  const directory = new OmpDirectoryGateway({ cwd: ".", ompFactory: failingFactory });
  context.after(() => directory.dispose());
  assert.equal(
    (await directory.sendDirectory({ type: "get_model_roles" })).code,
    "omp_directory_unavailable",
  );
  assert.equal(await directory.availability(), "unavailable");
  assert.equal((await directory.send({ type: "get_available_commands" })).success, false);
  assert.equal(instances.length, 1);
  assert.equal(instances[0]!.disposals, 1);
});

test("目录 owner 释放后旧启动完成不能安装进程或派发查询", async () => {
  const { factory, instances } = controlledDirectoryProcesses();
  const directory = new OmpDirectoryGateway({ cwd: ".", ompFactory: factory });
  const query = directory.sendDirectory({ type: "get_model_roles" });
  const old = instances[0]!;
  await directory.dispose();
  old.releaseStart();
  assert.equal((await query).code, "omp_directory_unavailable");
  assert.equal(await directory.availability(), "unavailable");
  assert.equal(old.disposals, 1);
  assert.deepEqual(old.sent, []);
  assert.equal(instances.length, 1);
});
