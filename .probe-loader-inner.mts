import { createWorkspaceConfigLoader } from "./packages/omp-agent/src/adapters/workspaceConfig.js";
import { createOmpProcessFactory } from "./packages/omp-agent/src/adapters/ompProcess.js";
const binary = process.argv[2]!;
const loader = createWorkspaceConfigLoader(createOmpProcessFactory(binary), process.cwd());
const state = await loader();
const modelOption = state.configOptions.find((o) => o.id === "model");
console.log(
  JSON.stringify({
    options: modelOption?.options?.length ?? -1,
    currentValue: modelOption?.currentValue,
    thoughtOptionCount: state.configOptions.filter((o) => o.id === "thought_level").length,
  }),
);
process.exit(0);
