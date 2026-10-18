import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createOmpProcessFactory } from "../src/adapters/ompProcess.js";
import { OmpDirectoryGateway } from "../src/adapters/ompDirectoryGateway.js";
import { logger } from "../src/adapters/logger.js";
import type { OmpSessionProcess } from "../src/app/ports.js";
import { ompStateDataSchema } from "../src/domain/ompFrames.js";
import { ompAvailableCommandsV3ResultSchema } from "../src/domain/ompForkFrames.js";
import { MOCK_MODEL_ID, MOCK_PROVIDER } from "./fixtures/ompMockServer.mjs";
import { prepareRealOmpFixture, realOmpSkip } from "./fixtures/realOmpHarness.js";

async function nativeAddons(directory: string): Promise<string[]> {
  const paths = await Promise.all(
    (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return nativeAddons(path);
      return entry.isFile() && entry.name.endsWith(".node") ? [path] : [];
    }),
  );
  return paths.flat();
}

async function assertReadyModel(core: OmpSessionProcess): Promise<void> {
  const state = await core.send({ type: "get_state" });
  assert.equal(state.success, true, JSON.stringify(state));
  const { model, isStreaming } = ompStateDataSchema.parse(state.data);
  assert.equal(model?.provider, MOCK_PROVIDER);
  assert.equal(model?.id, MOCK_MODEL_ID);
  assert.equal(isStreaming, false);

  const directory = await core.send({ type: "get_available_commands" });
  assert.equal(directory.success, true, JSON.stringify(directory));
  const { commands } = ompAvailableCommandsV3ResultSchema.parse(directory.data);
  assert.ok(
    commands.some((command) => command.name === "model"),
    "real core exposes /model",
  );
}

test(
  "real Windows cores cold-start concurrently with separate native caches and preserve shared resources",
  {
    skip:
      realOmpSkip ||
      (process.platform !== "win32" && "Windows native extraction regression（未验证）"),
  },
  async () => {
    const fixture = await prepareRealOmpFixture();
    const cores: OmpSessionProcess[] = [];
    try {
      const env = fixture.launch.env;
      const cacheRoot = z.string().min(1).parse(env.PI_NATIVES_DIR);
      const binary = z.string().min(1).parse(env.OMP_RPC_BINARY_PATH);
      const args = z.array(z.string()).parse(JSON.parse(env.OMP_RPC_ARGS_JSON));
      const sentinelName = "shared-cache-sentinel";
      const sentinel = join(cacheRoot, sentinelName);
      const sentinelContent = "pre-existing shared cache must survive every core disposal\n";
      await mkdir(cacheRoot, { recursive: true });
      await writeFile(sentinel, sentinelContent);
      const factory = createOmpProcessFactory(binary, args, env);
      const exits: Array<number | null | undefined> = [undefined, undefined];
      for (const index of [0, 1]) {
        cores.push(
          factory.create({
            cwd: fixture.workspace,
            sessionless: true,
            onEvent: () => undefined,
            onUiRequest: () => undefined,
            onExit: (code) => {
              exits[index] = code;
            },
          }),
        );
      }

      // No core has run and no native payload has been pre-extracted or warmed up.
      assert.deepEqual(await readdir(cacheRoot), [sentinelName]);
      await Promise.all(cores.map((core) => core.start()));
      await Promise.all(cores.map(assertReadyModel));
      assert.deepEqual(exits, [undefined, undefined], "both real cores remain alive together");

      const entries = await readdir(cacheRoot, { withFileTypes: true });
      const leaves = entries.filter((entry) => entry.name !== sentinelName);
      assert.equal(leaves.length, 2, "one distinct owned native cache per live core");
      assert.ok(leaves.every((entry) => entry.isDirectory()));
      assert.notEqual(leaves[0]!.name, leaves[1]!.name);
      for (const leaf of leaves) {
        const addons = await nativeAddons(join(cacheRoot, leaf.name));
        assert.ok(addons.length > 0, "each cold core extracted its own native addon");
        for (const addon of addons) assert.ok((await stat(addon)).size > 0);
      }
      assert.equal(await readFile(sentinel, "utf8"), sentinelContent);

      // dispose must await actual child closure before removing its loaded native cache.
      await cores[0]!.dispose();
      assert.equal(exits[1], undefined, "disposing one core must not close the other");
      const remaining = (await readdir(cacheRoot)).filter((name) => name !== sentinelName);
      assert.equal(remaining.length, 1, "only the disposed core's cache was removed");
      assert.ok(leaves.some((leaf) => leaf.name === remaining[0]));
      await assertReadyModel(cores[1]!);
      assert.equal(exits[1], undefined);

      await cores[1]!.dispose();
      assert.deepEqual(await readdir(cacheRoot), [sentinelName], "all owned leaves are reclaimed");
      assert.equal(await readFile(sentinel, "utf8"), sentinelContent);
      fixture.mock.assertHealthy();
      assert.equal(
        fixture.mock.calls.length,
        0,
        "startup and directory reads never invoke the model",
      );
    } finally {
      try {
        await Promise.allSettled(cores.map((core) => core.dispose()));
      } finally {
        await fixture.close();
      }
    }
  },
);

test(
  "real directory EOF consumes shutdown notifications without inventing UI responses",
  { skip: realOmpSkip },
  async (context) => {
    const fixture = await prepareRealOmpFixture();
    const warnings = context.mock.method(logger, "warn");
    const lifecycle = context.mock.method(logger, "info");
    const methods: string[] = [];
    const responses: string[] = [];
    let stopping = false;
    const factory = createOmpProcessFactory(
      z.string().min(1).parse(fixture.launch.env.OMP_RPC_BINARY_PATH),
      z.array(z.string()).parse(JSON.parse(fixture.launch.env.OMP_RPC_ARGS_JSON)),
      fixture.launch.env,
    );
    const directory = new OmpDirectoryGateway({
      cwd: fixture.workspace,
      ompFactory: {
        create(options) {
          return factory.create({
            ...options,
            onUiRequest(request) {
              if (stopping) methods.push(request.frame.method);
              options.onUiRequest({
                ...request,
                respond(response) {
                  responses.push(request.frame.method);
                  request.respond(response);
                },
              });
            },
          });
        },
      },
    });
    try {
      const outcome = await directory.send({ type: "get_available_commands" });
      assert.equal(outcome.success, true, JSON.stringify(outcome));
      stopping = true;
      await directory.dispose();
      assert.ok(methods.includes("setWidget"), "real session_shutdown clears its native widget");
      assert.deepEqual(responses, [], "native notifications never create pending UI responses");
      assert.ok(
        warnings.mock.calls.every(
          ({ arguments: args }) => args[1]?.event !== "omp_core_ui_response_failed",
        ),
        "EOF notification consumption must not attempt writes to a disposed child",
      );
      assert.ok(
        lifecycle.mock.calls.some(
          ({ arguments: args }) =>
            args[1]?.event === "omp_core_exited" &&
            args[1]?.code === 0 &&
            args[1]?.stage === "dispose",
        ),
        "the real directory core exits normally after stdin EOF",
      );
      fixture.mock.assertHealthy();
      assert.equal(fixture.mock.calls.length, 0, "directory lifecycle never invokes the model");
    } finally {
      try {
        await directory.dispose();
      } finally {
        await fixture.close();
      }
    }
  },
);
