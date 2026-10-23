import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";

export interface NativeOmpModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinking: string[] | null;
}

function nativeSourceCommand() {
  const command = process.env.ZCODE_AGENT_SERVER_COMMAND;
  const args = JSON.parse(process.env.ZCODE_AGENT_SERVER_ARGS_JSON || "[]") as string[];
  const entry = args.find((arg) => isAbsolute(arg) && /[/\\]src[/\\]cli\.ts$/u.test(arg));
  if (!command || !/^bun(?:\.exe)?$/iu.test(basename(command)) || !entry) {
    throw new Error("Native acceptance requires Bun and the absolute OMP src/cli.ts entry");
  }
  if (!process.env.PI_CODING_AGENT_DIR || !process.env.OMP_CONFIG_ROOT) {
    throw new Error("Native acceptance requires the runner's isolated OMP profile");
  }
  return { command, entry };
}

export async function runOmpNativeSource<T>(source: string, cwd: string): Promise<T> {
  const { command, entry } = nativeSourceCommand();
  const { stdout } = await promisify(execFile)(command, ["--eval", source], {
    cwd,
    env: { ...process.env, OMP_E2E_SOURCE_DIR: dirname(entry) },
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = stdout.split("\n").find((line) => line.startsWith("OMP_E2E_RESULT:"));
  if (!result) throw new Error("Native source query did not return its result");
  return JSON.parse(result.slice("OMP_E2E_RESULT:".length)) as T;
}

export async function readNativeOmpModels(cwd: string): Promise<NativeOmpModel[]> {
  const { command, entry } = nativeSourceCommand();
  const { stdout } = await promisify(execFile)(command, [entry, "models", "ls", "--json"], {
    cwd,
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = JSON.parse(stdout) as { models: NativeOmpModel[] };
  if (!Array.isArray(result.models)) throw new Error("Native models CLI returned no catalog");
  return result.models;
}

export async function readNativeOmpThinking(cwd: string) {
  return runOmpNativeSource<
    Array<{
      provider: string;
      id: string;
      reasoning: boolean;
      unverified: boolean;
      efforts: string[];
    }>
  >(
    `import { resolve } from "node:path";
     import { pathToFileURL } from "node:url";
     // The actual OMP checkout is runtime-selected by the runner.
     const load = (file) => import(pathToFileURL(resolve(process.env.OMP_E2E_SOURCE_DIR, file)).href);
     const { Settings } = await load("config/settings.ts");
     const { ModelRegistry } = await load("config/model-registry.ts");
     const { discoverAuthStorage, initializeCompanyModelLane } = await load("sdk.ts");
     const { getSupportedEfforts } = await load("../../catalog/src/model-thinking.ts");
     const offline = process.env.OMP_OFFLINE === "1";
     initializeCompanyModelLane(offline);
     const settings = await Settings.init({ cwd: process.cwd() });
     const auth = await discoverAuthStorage(undefined, { settings });
     try {
       const registry = new ModelRegistry(auth, undefined, { settings });
       await registry.refresh(offline ? "offline" : "online-if-uncached");
       console.log("OMP_E2E_RESULT:" + JSON.stringify(registry.getAvailable().map(model => ({
         provider: model.provider, id: model.id, reasoning: model.reasoning,
         unverified: Boolean(model.thinking?.unverified), efforts: getSupportedEfforts(model),
       }))));
     } finally { auth.close(); }`,
    cwd,
  );
}

export async function writeNativeOmpApiKey(provider: string, cwd: string): Promise<void> {
  const result = await runOmpNativeSource<{ stored: boolean }>(
    `import { resolve } from "node:path";
     import { pathToFileURL } from "node:url";
     const { AuthStorage } = await import(pathToFileURL(resolve(process.env.OMP_E2E_SOURCE_DIR, "session/auth-storage.ts")).href);
     const auth = await AuthStorage.create(resolve(process.env.PI_CODING_AGENT_DIR, "agent.db"));
     try {
       await auth.credentials.storeLoginApiKey(${JSON.stringify(provider)}, process.env.OMP_E2E_NATIVE_AUTH_KEY);
       console.log("OMP_E2E_RESULT:" + JSON.stringify({ stored: true }));
     } finally { auth.credentials.close(); }`,
    cwd,
  );
  if (!result.stored) throw new Error("Native credential write failed");
}

export async function readNativeOmpAuthFingerprint(cwd: string): Promise<string> {
  return runOmpNativeSource<string>(
    `import { resolve } from "node:path";
     import { pathToFileURL } from "node:url";
     // Source checkout location is supplied only at runtime by the integration runner.
     const { AuthStorage } = await import(pathToFileURL(resolve(process.env.OMP_E2E_SOURCE_DIR, "session/auth-storage.ts")).href);
     const auth = await AuthStorage.create(resolve(process.env.PI_CODING_AGENT_DIR, "agent.db"));
     try {
       await auth.credentials.reload();
       const rows = [...auth.credentials.providers()].sort().map(provider => [provider, auth.credentials.credentials(provider)]);
       console.log("OMP_E2E_RESULT:" + JSON.stringify(Bun.SHA256.hash(JSON.stringify(rows), "hex")));
     } finally { auth.credentials.close(); }`,
    cwd,
  );
}
