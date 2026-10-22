// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexProgress } from "@zcode/shared/omp-indexes";
import { ZCodeIntlProvider } from "../src/i18n/index.js";
import { WikiPage } from "../src/omp-configuration/WikiPage.js";
import { RepoPage } from "../src/omp-configuration/RepoPage.js";
import { useOmpIndexes } from "../src/omp-configuration/useOmpIndexes.js";
const fixture = vi.hoisted(() => ({
  wiki: vi.fn(),
  repo: vi.fn(),
  listener: null as ((event: IndexProgress) => void) | null,
}));
const service = {
  queryOmpWiki: fixture.wiki,
  queryOmpRepo: fixture.repo,
  onOmpIndexProgress: (listener: (event: IndexProgress) => void) => {
    fixture.listener = listener;
    return {
      dispose() {
        fixture.listener = null;
      },
    };
  },
};
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => ({
    services: { zcodeAgentService: service },
    rpcReady: true,
    isRemoteTarget: true,
  }),
}));
afterEach(cleanup);
beforeEach(() => {
  fixture.wiki.mockReset();
  fixture.repo.mockReset();
  fixture.listener = null;
});
const section = (id: number, text: string) => ({
  sectionId: id,
  index: "manual",
  documentHash: "hash",
  path: "/remote/docs/api.md",
  headingPath: "API",
  lineStart: 1,
  lineEnd: 8,
  text,
  shape: "content",
  matchKind: "exact-name",
  rank: 1,
});
describe("OMP index consumers", () => {
  it("routes remote identity, matches progress by operation, cancels without accepting stale result", async () => {
    const pending = Promise.withResolvers<{ indexes: never[] }>();
    fixture.wiki.mockImplementation((request) =>
      request.action === "cancel" ? Promise.resolve({ cancelled: true }) : pending.promise,
    );
    const { result } = renderHook(() =>
      useOmpIndexes("wiki", {
        workspacePath: "/remote/project",
        workspaceIdentity: "remote:one",
        remoteSessionId: "attachment",
      }),
    );
    let response!: Promise<unknown>;
    act(() => {
      response = result.current.run({ action: "list" });
    });
    const request = fixture.wiki.mock.calls[0]![0];
    expect(request.workspacePath).toBe("/remote/project");
    expect(request.workspaceIdentity).toBe("remote:one");
    expect(request.remoteSessionId).toBe("attachment");
    act(() =>
      fixture.listener?.({
        ...request,
        kind: "wiki",
        operationId: "other",
        progress: { phase: "scan", completed: 1, total: 3, failed: 0 },
      }),
    );
    expect(result.current.progress).toBeNull();
    act(() =>
      fixture.listener?.({
        ...request,
        kind: "wiki",
        progress: { phase: "scan", completed: 1, total: 3, failed: 0 },
      }),
    );
    expect(result.current.progress).toMatchObject({ completed: 1 });
    await act(async () => {
      await result.current.cancel();
    });
    expect(fixture.wiki).toHaveBeenLastCalledWith({
      action: "cancel",
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
      remoteSessionId: request.remoteSessionId,
      operationId: request.operationId,
    });
    await act(async () => {
      pending.resolve({ indexes: [] });
      expect(await response).toBeNull();
    });
    expect(result.current.busy).toBe(false);
  });
  it("discards the previous workspace response rather than publishing it into the next workspace", async () => {
    const pending = Promise.withResolvers<{ indexes: never[] }>();
    fixture.repo.mockImplementation((request) =>
      request.action === "cancel" ? Promise.resolve({ cancelled: true }) : pending.promise,
    );
    const { result, rerender } = renderHook(
      ({ identity }) =>
        useOmpIndexes("repo", { workspacePath: "/same/path", workspaceIdentity: identity }),
      { initialProps: { identity: "one" } },
    );
    let response!: Promise<unknown>;
    act(() => {
      response = result.current.run({ action: "status" });
    });
    rerender({ identity: "two" });
    await act(async () => {
      pending.resolve({ indexes: [] });
      expect(await response).toBeNull();
    });
    expect(fixture.repo).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cancel", workspaceIdentity: "one" }),
    );
  });
  it("renders stored full Wiki bodies and continues the submitted query even after editing the form", async () => {
    fixture.wiki.mockImplementation(async (request) => {
      if (request.action === "list") return { indexes: [] };
      if (request.cursor)
        return {
          sections: [section(2, "second complete body")],
          total: 2,
          hasMore: false,
          exactNameMatches: 2,
        };
      return {
        sections: [section(1, "first complete body\nsource content")],
        total: 2,
        hasMore: true,
        cursor: "opaque-native-cursor",
        exactNameMatches: 2,
      };
    });
    render(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(WikiPage, {
          workspacePath: "/remote/project",
          workspaceIdentity: "remote:one",
        }),
      }),
    );
    await waitFor(() =>
      expect(fixture.wiki).toHaveBeenCalledWith(expect.objectContaining({ action: "list" })),
    );
    fireEvent.change(screen.getByTestId("omp-wiki-query"), { target: { value: "NativeApi" } });
    fireEvent.click(screen.getByTestId("omp-wiki-search"));
    await screen.findByText(/first complete body/);
    fireEvent.change(screen.getByTestId("omp-wiki-query"), { target: { value: "different" } });
    fireEvent.click(screen.getByTestId("omp-wiki-next"));
    await screen.findByText("second complete body");
    expect(fixture.wiki).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "NativeApi", cursor: "opaque-native-cursor" }),
    );
    expect(screen.getByTestId("omp-wiki-results").textContent).toContain("/remote/docs/api.md:1–8");
  });
  it("does not submit an index build before explicit directory/name confirmation", async () => {
    fixture.wiki.mockResolvedValue({ indexes: [] });
    render(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(WikiPage, { workspacePath: "/remote/project" }),
      }),
    );
    await waitFor(() => expect(fixture.wiki).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("omp-wiki-directory"), {
      target: { value: "/remote/manuals" },
    });
    fireEvent.change(screen.getByTestId("omp-wiki-name"), { target: { value: "manual" } });
    fireEvent.click(screen.getByTestId("omp-wiki-init"));
    expect(screen.getByTestId("omp-wiki-confirm-directory").textContent).toBe("/remote/manuals");
    expect(fixture.wiki.mock.calls.some(([request]) => request.action === "init")).toBe(false);
    fireEvent.click(screen.getByTestId("omp-index-confirm"));
    await waitFor(() =>
      expect(fixture.wiki).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "init",
          name: "manual",
          directory: "/remote/manuals",
          confirmedDirectory: "/remote/manuals",
        }),
      ),
    );
  });
  it("confirms the complete native Repo root and preserves the old view when maintenance fails", async () => {
    const status = {
      root: "/remote/repository",
      exists: true,
      generation: "published-generation",
      fileCount: 3,
      symbolCount: 4,
      failures: [],
      failureCount: 0,
      failuresTruncated: false,
      pendingPaths: [],
      pendingCount: 0,
      pendingTruncated: false,
      needsReconcile: false,
      uncertainReasons: [],
      uncertainCount: 0,
      uncertaintyTruncated: false,
      unchecked: false,
      lastFullCheck: 1,
      incomplete: false,
      exclusions: [],
    };
    fixture.repo.mockImplementation(async (request) => {
      if (request.action === "status") return status;
      if (request.action === "text")
        return {
          root: status.root,
          generation: status.generation,
          status: "ok",
          hits: [
            {
              path: "src/api.ts",
              category: "source",
              startLine: 1,
              endLine: 2,
              snippet: "old published source",
            },
          ],
          truncated: false,
          warnings: [],
          coverage: status,
        };
      throw new Error("Native rebuild failed");
    });
    render(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(RepoPage, { workspacePath: "/remote/repository/subdir" }),
      }),
    );
    await screen.findByText(/published-generation/);
    fireEvent.change(screen.getByTestId("omp-repo-query"), { target: { value: "published" } });
    fireEvent.click(screen.getByTestId("omp-repo-search"));
    await screen.findByText("old published source");
    fireEvent.click(screen.getByTestId("omp-repo-rebuild"));
    expect(screen.getByTestId("omp-repo-confirm-root").textContent).toBe("/remote/repository");
    expect(fixture.repo.mock.calls.some(([request]) => request.action === "rebuild")).toBe(false);
    fireEvent.click(screen.getByTestId("omp-index-confirm"));
    await screen.findByText("Native rebuild failed");
    expect(screen.getByText("old published source")).toBeTruthy();
    expect(screen.getByTestId("omp-repo-status").getAttribute("data-generation")).toBe(
      "published-generation",
    );
    expect(fixture.repo).toHaveBeenCalledWith(
      expect.objectContaining({ action: "rebuild", confirmedRoot: "/remote/repository" }),
    );
  });
});
