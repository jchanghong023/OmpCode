import { describe, expect, it, vi, type Mock } from "vitest";
import { zcodeProtocolMethods } from "@zcode/shared";
import { V4_METHODS, V4_NOTIFICATIONS } from "@zcode/shared/zcode-protocol-v4";

interface MockClient {
  request: Mock;
  transportKind: "stdio";
  onNotification: Mock<
    (listener: (message: { method: string; params: unknown }) => void) => { dispose(): void }
  >;
  onRequest: Mock;
  onClose: Mock;
}

function createClient(request = vi.fn()): MockClient {
  return {
    request,
    transportKind: "stdio" as const,
    onNotification: vi.fn(() => ({ dispose() {} })),
    onRequest: vi.fn(() => ({ dispose() {} })),
    onClose: vi.fn(() => ({ dispose() {} })),
  };
}

async function setup(getClient = vi.fn(async () => createClient())) {
  const disposeWorkspace = vi.fn(async () => {});
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      getClient = getClient;
      disposeWorkspace = disposeWorkspace;
      onRuntimeLifecycle() {
        return { dispose() {} };
      }
      onRuntimeRestarted() {
        return { dispose() {} };
      }
      markReady() {}
      disposeAll() {}
    },
  }));
  // vi.resetModules/doMock 隔离每个 service 的进程 owner，必须在安装本用例 mock 后加载。
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  return { service: createZCodeAgentService(), getClient, disposeWorkspace };
}

const firstInput = {
  commandId: "first-input",
  clientId: "host-client",
  sessionId: "sess_1",
  type: "sendText" as const,
  payload: { text: "first input" },
  issuedAt: 1,
};

function createAcceptingClient() {
  return createClient(
    vi.fn(async () => ({
      commandId: firstInput.commandId,
      status: "accepted" as const,
      revisionAtDecision: 1,
    })),
  );
}

describe("createZCodeAgentService native runtime lifecycle", () => {
  it("shares one startup generation between concurrent initialize callers", async () => {
    const startup = Promise.withResolvers<MockClient>();
    const { service, getClient } = await setup(vi.fn(() => startup.promise));
    const workspace = { workspacePath: "/workspace/concurrent-startup" };
    try {
      const first = service.initialize(workspace);
      const second = service.initialize(workspace);
      expect(getClient).toHaveBeenCalledTimes(1);
      startup.resolve(createClient());
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ available: true }),
        expect.objectContaining({ available: true }),
      ]);
      await expect(service.initialize(workspace)).resolves.toMatchObject({ available: true });
      expect(getClient).toHaveBeenCalledTimes(1);
    } finally {
      startup.resolve(createClient());
      service.disposeAll();
    }
  });

  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "shares startup between warmup and the first command: %s",
    async (clientMode) => {
      const client = createAcceptingClient();
      const startup = Promise.withResolvers<typeof client>();
      const { service, getClient } = await setup(vi.fn(() => startup.promise));
      const workspace = {
        workspacePath: "/workspace/concurrent-first-input",
        ...(clientMode === "web-remote-replayable"
          ? { workspaceIdentity: "remote:ssh:first:/workspace/concurrent-first-input" }
          : {}),
      };
      try {
        const warmup = service.initialize(workspace);
        const command = service.sendConversationCommandV4({
          ...workspace,
          clientMode,
          envelope: firstInput,
        });
        // 预热和首条输入必须共享真实进程启动，不再依赖 Host 模型配置读取的完成顺序。
        expect(getClient).toHaveBeenCalledTimes(1);
        expect(client.request).not.toHaveBeenCalled();
        startup.resolve(client);
        await expect(warmup).resolves.toMatchObject({ available: true });
        await expect(command).resolves.toMatchObject({ status: "accepted" });
        expect(getClient).toHaveBeenCalledTimes(1);
        expect(client.request).toHaveBeenCalledExactlyOnceWith(
          V4_METHODS.command,
          expect.objectContaining({ commandId: "first-input", type: "sendText" }),
          expect.anything(),
        );
      } finally {
        startup.resolve(client);
        service.disposeAll();
      }
    },
  );

  it("keeps remote identities with the same filesystem path on separate runtimes", async () => {
    const clients = [createAcceptingClient(), createAcceptingClient()];
    const getClient = vi.fn().mockResolvedValueOnce(clients[0]).mockResolvedValueOnce(clients[1]);
    const { service } = await setup(getClient);
    const workspaces = ["first", "second"].map((host) => ({
      workspacePath: "/workspace/app",
      workspaceIdentity: `remote:ssh:${host}:/workspace/app`,
      remoteSessionId: `remote-${host}`,
    }));
    try {
      await Promise.all(workspaces.map((workspace) => service.initialize(workspace)));
      for (const workspace of workspaces) {
        await expect(service.initialize(workspace)).resolves.toMatchObject({
          available: true,
          workspaceKey: workspace.workspaceIdentity,
        });
        await service.sendConversationCommandV4({ ...workspace, envelope: firstInput });
      }
      expect(getClient).toHaveBeenCalledTimes(2);
      for (const [index, workspace] of workspaces.entries()) {
        expect(getClient).toHaveBeenCalledWith(expect.objectContaining(workspace));
        expect(clients[index]?.request).toHaveBeenCalledExactlyOnceWith(
          V4_METHODS.command,
          expect.objectContaining({ commandId: firstInput.commandId }),
          expect.anything(),
        );
      }
    } finally {
      service.disposeAll();
    }
  });

  it("rejects a late startup after workspace release without starting another process", async () => {
    const startup = Promise.withResolvers<MockClient>();
    const { service, getClient, disposeWorkspace } = await setup(vi.fn(() => startup.promise));
    const workspace = { workspacePath: "/workspace/released-during-startup" };
    try {
      const initial = service.initialize(workspace);
      await service.disposeWorkspace(workspace);
      startup.resolve(createClient());
      await expect(initial).resolves.toMatchObject({ available: false });
      expect(disposeWorkspace).toHaveBeenCalledWith(workspace);
      expect(getClient).toHaveBeenCalledTimes(1);
    } finally {
      startup.resolve(createClient());
      service.disposeAll();
    }
  });

  it("does not let a released generation borrow the reopened workspace runtime", async () => {
    const oldStartup = Promise.withResolvers<MockClient>();
    const oldClient = createClient();
    const currentClient = createAcceptingClient();
    const getClient = vi
      .fn()
      .mockReturnValueOnce(oldStartup.promise)
      .mockResolvedValue(currentClient);
    const { service } = await setup(getClient);
    const workspace = { workspacePath: "/workspace/reopened-during-startup" };
    try {
      const initial = service.initialize(workspace);
      await service.disposeWorkspace(workspace);
      await expect(service.initialize(workspace)).resolves.toMatchObject({ available: true });
      oldStartup.resolve(oldClient);
      await expect(initial).resolves.toMatchObject({ available: false });
      await expect(
        service.sendConversationCommandV4({ ...workspace, envelope: firstInput }),
      ).resolves.toMatchObject({ status: "accepted" });
      expect(getClient).toHaveBeenCalledTimes(2);
      expect(oldClient.request).not.toHaveBeenCalled();
      expect(currentClient.request).toHaveBeenCalledOnce();
    } finally {
      oldStartup.resolve(oldClient);
      service.disposeAll();
    }
  });

  it("delivers an initial runtime event while startup is wiring the client", async () => {
    const event = {
      sessionId: "sess_1",
      executionId: "execution-1",
      offPeakTaskId: "task-1",
      type: "ticket_released" as const,
      ticketId: "ticket-1",
    };
    const client = createClient();
    client.onNotification.mockImplementation((listener) => {
      listener({ method: V4_NOTIFICATIONS.offPeakLifecycle, params: event });
      return { dispose() {} };
    });
    const { service } = await setup(vi.fn(async () => client));
    const workspace = { workspacePath: "/workspace/initial-event" };
    const listener = vi.fn();
    const foreignListener = vi.fn();
    const subscription = service.onDynamicOffPeakLifecycle(workspace)(listener);
    const foreign = service.onDynamicOffPeakLifecycle({ workspacePath: "/workspace/other" })(
      foreignListener,
    );
    try {
      await expect(service.initialize(workspace)).resolves.toMatchObject({ available: true });
      expect(listener).toHaveBeenCalledExactlyOnceWith(event);
      expect(foreignListener).not.toHaveBeenCalled();
    } finally {
      subscription.dispose();
      foreign.dispose();
      service.disposeAll();
    }
  });

  it("reuses a read-only sessions-index client for model execution", async () => {
    const client = createClient(
      vi.fn(async () => ({
        ack: {
          subscriptionId: "sub-readonly",
          mode: "snapshot" as const,
          logEpoch: "epoch-readonly",
        },
      })),
    );
    const { service, getClient } = await setup(vi.fn(async () => client));
    const workspace = { workspacePath: "/workspace/read-only-then-execute" };
    try {
      await service.subscribeSessionsIndexV4(workspace);
      await expect(service.initialize(workspace)).resolves.toMatchObject({ available: true });
      expect(getClient).toHaveBeenCalledTimes(1);
      expect(client.request.mock.calls.map(([method]) => method)).toEqual([
        V4_METHODS.conversationSubscribe,
      ]);
    } finally {
      service.disposeAll();
    }
  });

  it("workspace presentation does not attach Host-derived model facts", async () => {
    const workspace = { workspacePath: "/workspace/app", workspaceKey: "/workspace/app" };
    const client = createClient(
      vi.fn(async () => ({ workspace, mode: "build", slashCommands: [] })),
    );
    const { service } = await setup(vi.fn(async () => client));
    try {
      await service.readWorkspacePresentation({ workspacePath: workspace.workspacePath });
      expect(client.request).toHaveBeenCalledExactlyOnceWith(
        zcodeProtocolMethods.workspaceReadPresentation,
        { workspace },
        expect.anything(),
      );
      expect(client.request.mock.calls[0]?.[1]).not.toHaveProperty("model");
    } finally {
      service.disposeAll();
    }
  });

  it("reacquires the client once when stdio closes during workspace presentation", async () => {
    const presentation = {
      workspace: { workspacePath: "/workspace/app", workspaceKey: "/workspace/app" },
      mode: "build",
      slashCommands: [],
    };
    const first = createClient(
      vi.fn(async () => {
        throw new Error("ZCode agent stdio transport is closed");
      }),
    );
    const second = createClient(vi.fn(async () => presentation));
    const getClient = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
    const { service } = await setup(getClient);
    try {
      await expect(
        service.readWorkspacePresentation({ workspacePath: presentation.workspace.workspacePath }),
      ).resolves.toMatchObject(presentation);
      expect(getClient).toHaveBeenCalledTimes(2);
      for (const client of [first, second]) {
        expect(client.request).toHaveBeenCalledExactlyOnceWith(
          zcodeProtocolMethods.workspaceReadPresentation,
          expect.anything(),
          expect.anything(),
        );
      }
    } finally {
      service.disposeAll();
    }
  });
});
