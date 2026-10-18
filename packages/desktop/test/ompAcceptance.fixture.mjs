// Test-only suite composition. Each leaf prepares inputs; only the real OMP owns execution facts.
import assert from "node:assert/strict";
import { prepareSuite as prepareConversation } from "./ompConversationAcceptance.fixture.mjs";
import { prepareSuite as prepareModels } from "./ompModelsAcceptance.fixture.mjs";
import { prepareSuite as prepareAgents } from "./ompAgentsAcceptance.fixture.mjs";
import { prepareSuite as prepareNative } from "./ompNativeAcceptance.fixture.mjs";
import { prepareSuite as prepareInteractions } from "./ompInteractionsAcceptance.fixture.mjs";
import { createStrictMockHandler } from "../../omp-agent/test/fixtures/ompMockScenarios.mjs";

const suites = {
  conversation: prepareConversation,
  models: prepareModels,
  agents: prepareAgents,
  native: prepareNative,
  interactions: prepareInteractions,
};

function prepareIdentity() {
  const strictHandler = createStrictMockHandler();
  const barriers = new Map();
  const states = {};
  return {
    handler(context, options) {
      const response = strictHandler(context, options);
      const marker = response.content.find(
        (part) => typeof part === "string" && /^GUI_IDENTITY_(FIRST|SECOND|THIRD)_/.test(part),
      );
      if (!marker) return response;
      assert.ok(options?.signal, "Identity streaming requires actual HTTP cancellation");
      assert.equal(barriers.has(marker), false, "Identity input must execute exactly once");
      const pending = Promise.withResolvers();
      barriers.set(marker, pending);
      // 短回复原先可能在 stop hover 前终结；沿用同块分片屏障，只暂停模型输出。
      // 原正文和思考块不变，真实 OMP 仍唯一持有运行态、会话身份和持久记录。
      return {
        ...response,
        delayMs: 0,
        content: response.content.map((part) =>
          part !== marker
            ? part
            : {
                type: "text",
                deltas: (async function* () {
                  yield marker;
                  states[marker] = "waiting";
                  await pending.promise;
                })(),
              },
        ),
      };
    },
    snapshot: () => ({ barriers: { ...states } }),
    control(action) {
      assert.deepEqual(Object.keys(action).sort(), ["name", "type"]);
      assert.equal(action.type, "release");
      assert.equal(states[action.name], "waiting", "Release only a waiting identity response");
      states[action.name] = "released";
      barriers.get(action.name).resolve();
      return { released: action.name };
    },
  };
}

export async function prepareAcceptanceSuite(options) {
  if (options.suite === "identity") return prepareIdentity();
  if (options.suite === "startup") return {};
  assert.ok(Object.hasOwn(suites, options.suite), `Unknown GUI acceptance suite: ${options.suite}`);
  const prepareSuite = suites[options.suite];
  assert.equal(
    typeof prepareSuite,
    "function",
    "Acceptance suite must own its real scenario setup",
  );
  const prepared = await prepareSuite(options);
  assert.ok(prepared && typeof prepared === "object", "Acceptance suite must return its contract");
  return prepared;
}
