import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORK_TEMPORARY_E2E_EXCLUDES,
  resolveDeferredFormalSpecExcludes,
} from "../scripts/e2e-formal-spec-selection.mjs";

import {
  assertNonEmptyE2EScheduledSpecFiles,
  resolveE2EScheduledSpecFiles,
} from "./e2e/helpers/e2e-spec-resolution.js";

function writeSpec(baseDir: string, relativePath: string): void {
  const path = join(baseDir, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "describe('x', () => {});\n");
}

function withFixture<T>(run: (baseDir: string) => T): T {
  const baseDir = mkdtempSync(join(tmpdir(), "zcode-e2e-spec-resolution-"));
  try {
    return run(baseDir);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
}

describe("E2E spec scheduling resolution", () => {
  it("resolves the formal non-recursive conversation-session CI glob", () => {
    withFixture((baseDir) => {
      writeSpec(baseDir, "test/e2e/conversation-session/formal-a.test.ts");
      writeSpec(baseDir, "test/e2e/conversation-session/formal-b.test.ts");
      writeSpec(baseDir, "test/e2e/conversation-session/manual-review/pending/manual.test.ts");

      expect(
        resolveE2EScheduledSpecFiles({
          baseDir,
          specs: ["./test/e2e/conversation-session/*.test.ts"],
          exclude: [],
        }),
      ).toEqual([
        "test/e2e/conversation-session/formal-a.test.ts",
        "test/e2e/conversation-session/formal-b.test.ts",
      ]);
    });
  });

  it("resolves a formal desktop CI spec list with a domain-specific single spec", () => {
    withFixture((baseDir) => {
      writeSpec(baseDir, "test/e2e/conversation-session/formal.test.ts");
      writeSpec(baseDir, "test/e2e/workspace-file-tree-refresh.test.ts");

      expect(
        resolveE2EScheduledSpecFiles({
          baseDir,
          specs: [
            "./test/e2e/conversation-session/*.test.ts",
            "./test/e2e/workspace-file-tree-refresh.test.ts",
          ],
          exclude: [],
        }),
      ).toEqual([
        "test/e2e/conversation-session/formal.test.ts",
        "test/e2e/workspace-file-tree-refresh.test.ts",
      ]);
    });
  });

  it("applies recursive exclude globs before reporting scheduled specs", () => {
    withFixture((baseDir) => {
      writeSpec(baseDir, "test/e2e/conversation-session/formal.test.ts");
      writeSpec(baseDir, "test/e2e/conversation-session/manual-review/pending/manual.test.ts");

      expect(
        resolveE2EScheduledSpecFiles({
          baseDir,
          specs: ["./test/e2e/**/*.test.ts"],
          exclude: ["./test/e2e/conversation-session/manual-review/**/*.test.ts"],
        }),
      ).toEqual(["test/e2e/conversation-session/formal.test.ts"]);
    });
  });

  it.each(
    [
      "./test/e2e/container-boot.test.ts",
      "./test/e2e/conversation-session/conversation-session-highspeed-card.test.ts",
      "./test/e2e/conversation-session/conversation-session-toolsearch-recording.test.ts",
    ].flatMap((spec) =>
      ["CLI", "environment"].flatMap((selection) =>
        ["relative", "absolute"].map((form) => ({ spec, selection, form })),
      ),
    ),
  )(
    "fails before worker startup for all-excluded explicit $selection $form selection $spec",
    ({ spec, selection, form }) => {
      withFixture((baseDir) => {
        writeSpec(baseDir, spec.slice(2));
        const request = form === "absolute" ? resolve(baseDir, spec) : spec;
        expect(() =>
          assertNonEmptyE2EScheduledSpecFiles({
            baseDir,
            specs: [request],
            exclude: FORK_TEMPORARY_E2E_EXCLUDES,
            requestedSpecs: selection === "CLI" ? [request] : [],
            envSpec: selection === "environment" ? request : undefined,
            argv: selection === "CLI" ? ["--spec", request] : [],
          }),
        ).toThrow(/Desktop E2E has no scheduled spec files after applying excludes/);
      });
    },
  );

  it("schedules only the retained member of a mixed explicit selection", () => {
    withFixture((baseDir) => {
      const retained =
        "test/e2e/conversation-session/conversation-session-send-message-resume-stop.test.ts";
      writeSpec(baseDir, "test/e2e/container-boot.test.ts");
      writeSpec(baseDir, retained);
      expect(
        assertNonEmptyE2EScheduledSpecFiles({
          baseDir,
          specs: ["./test/e2e/container-boot.test.ts", `./${retained}`],
          exclude: FORK_TEMPORARY_E2E_EXCLUDES,
          requestedSpecs: ["./test/e2e/container-boot.test.ts", `./${retained}`],
          argv: ["--spec", "./test/e2e/container-boot.test.ts", "--spec", `./${retained}`],
        }),
      ).toEqual([retained]);
    });
  });

  it.each([
    "./test/e2e/conversation-session/conversation-session-bot-channel-worker.test.ts",
    "./test/e2e/bots/feishu-channel-mention.test.ts",
    "./test/e2e/automations-custom-monthly-interval.test.ts",
    "./test/e2e/off-peak-create-manage.test.ts",
  ])("defers %s for default and glob requests but admits an exact absolute target", (target) => {
    withFixture((baseDir) => {
      const retained = ["test/e2e/bots/bot-runtime-authority.test.ts"];
      for (const spec of [target.slice(2), ...retained]) {
        writeSpec(baseDir, spec);
      }
      const glob = "./test/e2e/**/*.test.ts";
      for (const requestedSpecs of [[], [glob]]) {
        expect(
          resolveE2EScheduledSpecFiles({
            baseDir,
            specs: [glob],
            exclude: [
              ...FORK_TEMPORARY_E2E_EXCLUDES,
              ...resolveDeferredFormalSpecExcludes({ requestedSpecs }),
            ],
          }),
        ).toEqual([...retained].sort());
      }
      const request = resolve(baseDir, target);
      expect(
        assertNonEmptyE2EScheduledSpecFiles({
          baseDir,
          specs: [request],
          exclude: [
            ...FORK_TEMPORARY_E2E_EXCLUDES,
            ...resolveDeferredFormalSpecExcludes({ requestedSpecs: [request] }),
          ],
          requestedSpecs: [request],
          argv: ["--spec", request],
        }),
      ).toEqual([target.slice(2)]);
    });
  });

  it("throws a pre-worker diagnostic when no spec files are scheduled", () => {
    withFixture((baseDir) => {
      expect(() =>
        assertNonEmptyE2EScheduledSpecFiles({
          baseDir,
          specs: ["./test/e2e/conversation-session/*.test.ts"],
          exclude: [],
          requestedSpecs: ["./test/e2e/conversation-session/*.test.ts"],
          envSpec: "./test/e2e/conversation-session/*.test.ts",
          argv: [
            "run",
            "wdio.conf.ts",
            "--",
            "--spec",
            "./test/e2e/conversation-session/*.test.ts",
          ],
        }),
      ).toThrow(/Desktop E2E has no scheduled spec files after applying excludes/);
    });
  });
});
