import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createOmpProcessFactory } from "../../omp-agent/src/adapters/ompProcess.js";

const binary = process.env.OMP_RPC_BINARY_PATH;
const workspace = process.argv[2];
const promptConfig = process.argv[3];
assert.ok(
  binary && workspace && promptConfig && process.env.OMP_CONFIG_ROOT && process.env.PI_NATIVES_DIR,
);
await mkdir(process.env.PI_NATIVES_DIR, { recursive: true });
const factory = createOmpProcessFactory(
  binary,
  ["--no-title", "--no-extensions", "--no-rules", "--no-lsp", "--no-pty", "--config", promptConfig],
  process.env,
);
const core = factory.create({
  cwd: workspace,
  sessionless: true,
  onEvent: () => undefined,
  onUiRequest: ({ frame }) => {
    // These display-only methods are fire-and-forget in the real RPC protocol, not input requests.
    // The directory consumer has no display target and must not fabricate a UI response.
    switch (frame.method) {
      case "notify":
      case "setStatus":
      case "setWidget":
      case "setTitle":
        return;
    }
    // Unexpected methods fail with routing metadata only, never UI text.
    throw new Error(
      `Read-only real command catalog received UI frame: ${JSON.stringify({ method: frame.method, id: frame.id })}`,
    );
  },
  onAskRequest: ({ frame }) => {
    throw new Error(
      `Read-only real command catalog received UI frame: ${JSON.stringify({ method: "ask", id: frame.id })}`,
    );
  },
  onExit: (code) => {
    assert.fail(`Read-only OMP exited outside owned disposal: ${JSON.stringify({ code })}`);
  },
});
let commands: unknown;
try {
  // start owns ready/protocol negotiation/native-cache lifetime, as in the existing real test.
  await core.start();
  const response = await core.send({ type: "get_available_commands" });
  assert.equal(response.success, true, JSON.stringify(response));
  assert.ok(response.data && typeof response.data === "object" && "commands" in response.data);
  const catalog = response.data.commands;
  assert.ok(
    Array.isArray(catalog) && catalog.length > 0,
    "The real OMP command directory must be nonempty",
  );
  commands = catalog.filter((command: { source?: string }) => command.source === "skill");
  assert.ok(
    Array.isArray(commands) && commands.length >= 4,
    "No empty source=skill catalog success",
  );
} finally {
  // dispose owns real child close and native-cache cleanup; onExit only reports unexpected exits.
  // The outer helper process must also close normally before its catalog is accepted.
  await core.dispose();
}
console.log(`NATIVE_CATALOG=${JSON.stringify(commands)}`);
