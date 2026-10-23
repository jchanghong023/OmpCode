import { describe, expect, it } from "vitest";
import {
  cancelledIndexSchema,
  indexProgressSchema,
  removedIndexSchema,
  repoRequestSchema,
  wikiListSchema,
  wikiQuerySchema,
  wikiRequestSchema,
} from "./contract.js";

const target = { workspacePath: "/workspace/project", operationId: "operation-1" };

describe("OMP index protocol boundaries", () => {
  it("rejects missing routing and operation correlation fields", () => {
    for (const schema of [wikiRequestSchema, repoRequestSchema]) {
      const action = schema === wikiRequestSchema ? "list" : "status";
      for (const invalid of [
        { action, operationId: target.operationId },
        { action, workspacePath: target.workspacePath },
        { ...target, action, workspacePath: "" },
        { ...target, action, operationId: "" },
        { ...target, action, workspaceIdentity: 42 },
        { ...target, action, remoteSessionId: 42 },
      ]) {
        expect(schema.safeParse(invalid).success).toBe(false);
      }
    }
  });

  it("requires explicit initialization and mutation confirmation fields", () => {
    for (const confirmedDirectory of [undefined, ""]) {
      expect(
        wikiRequestSchema.safeParse({
          ...target,
          action: "init",
          directory: "/docs",
          name: "manual",
          confirmedDirectory,
        }).success,
      ).toBe(false);
    }
    for (const action of ["init", "update", "rebuild", "remove"]) {
      for (const confirmedRoot of [undefined, ""]) {
        expect(repoRequestSchema.safeParse({ ...target, action, confirmedRoot }).success).toBe(
          false,
        );
      }
    }
  });

  it("rejects empty queries, fractional limits and limits outside each native page bound", () => {
    for (const action of ["search", "grep"]) {
      for (const limit of [0, 201, 1.5]) {
        expect(
          wikiRequestSchema.safeParse({ ...target, action, query: "clock", limit }).success,
        ).toBe(false);
      }
      expect(wikiRequestSchema.safeParse({ ...target, action, query: "" }).success).toBe(false);
      for (const characterBudget of [0, 1000001, 1.5]) {
        expect(
          wikiRequestSchema.safeParse({ ...target, action, query: "clock", characterBudget })
            .success,
        ).toBe(false);
      }
    }
    for (const action of ["text", "symbol"]) {
      for (const limit of [0, 51, 1.5]) {
        expect(
          repoRequestSchema.safeParse({ ...target, action, query: "clock", limit }).success,
        ).toBe(false);
      }
      expect(repoRequestSchema.safeParse({ ...target, action, query: "" }).success).toBe(false);
      expect(
        repoRequestSchema.safeParse({ ...target, action, query: "clock", category: "generated" })
          .success,
      ).toBe(false);
    }
  });

  it("rejects unknown fields on every action instead of silently stripping them", () => {
    const wikiActions = [
      { action: "list" },
      { action: "init", directory: "/docs", confirmedDirectory: "/docs", name: "manual" },
      { action: "remove", name: "manual" },
      { action: "search", query: "clock" },
      { action: "grep", query: "clock" },
      { action: "cancel" },
    ];
    const repoActions = [
      { action: "status" },
      ...["init", "update", "rebuild", "remove"].map((action) => ({
        action,
        confirmedRoot: target.workspacePath,
      })),
      ...["text", "symbol"].map((action) => ({ action, query: "clock" })),
      { action: "cancel" },
    ];
    for (const action of wikiActions) {
      expect(wikiRequestSchema.safeParse({ ...target, ...action, unexpected: true }).success).toBe(
        false,
      );
    }
    for (const action of repoActions) {
      expect(repoRequestSchema.safeParse({ ...target, ...action, unexpected: true }).success).toBe(
        false,
      );
    }
  });

  it("rejects malformed terminal results and unknown nested result fields", () => {
    expect(removedIndexSchema.safeParse({ removed: false }).success).toBe(false);
    expect(cancelledIndexSchema.safeParse({ cancelled: "true" }).success).toBe(false);
    expect(cancelledIndexSchema.safeParse({ cancelled: true, operationId: "extra" }).success).toBe(
      false,
    );
    expect(
      wikiListSchema.safeParse({
        indexes: [
          {
            id: 1,
            name: "manual",
            rootPath: "/docs",
            documentCount: 0,
            sectionCount: 0,
            stale: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      wikiQuerySchema.safeParse({
        sections: [],
        total: 0,
        hasMore: false,
        exactNameMatches: 0,
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("rejects uncorrelated progress, unknown phases and extra nested fields", () => {
    const progress = { phase: "parsing", processed: 0, total: 1 };
    for (const invalid of [
      { workspacePath: target.workspacePath, kind: "repo", progress },
      { ...target, kind: "repo", progress: { ...progress, phase: "complete" } },
      { ...target, kind: "repo", progress: { ...progress, accepted: true } },
      { ...target, kind: "wiki", progress: { phase: "scan", total: 1, completed: 0 } },
      { ...target, kind: "repo", progress, sessionId: "extra" },
    ]) {
      expect(indexProgressSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
