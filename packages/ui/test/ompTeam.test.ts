import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ompTeamRequestSchema, ompTeamRunSchema, type OmpTeamRun } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/index.js";
import { TeamRunView } from "../src/omp-configuration/TeamRunView.js";
import { TeamPage } from "../src/omp-configuration/TeamPage.js";

vi.mock("@/hooks/useZCodeAgentService.js", () => ({ useZCodeAgentService: () => ({}) }));

const run: OmpTeamRun = {
  jobId: "job-1",
  sessionId: "session-1",
  label: "Native Team",
  status: "completed",
  participants: [],
  source: "native-journal",
  unavailable: ["No causal evidence for synthesis"],
  nodes: ["call-a", "call-b"].map((id) => ({
    id,
    label: "Same model",
    role: "proposer",
    model: "provider/model",
    status: "completed",
    tools: [],
    messages: [],
  })),
  edges: [
    { source: "call-b", target: "call-a", kind: "reviews", evidence: "native invocation label" },
  ],
  timeline: [
    { sequence: 1, timestamp: 1, kind: "child_complete", nodeId: "call-a", data: { native: true } },
  ],
};
function markup(value: OmpTeamRun, connected = true) {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(TeamRunView, {
        run: value,
        connected,
        busy: false,
        onStop: () => {},
      }),
    }),
  );
}
describe("Native Team observation consumer", () => {
  it("rejects extra wire fields instead of extending the original protocol", () => {
    expect(
      ompTeamRequestSchema.safeParse({ action: "list", sessionId: "s", cwd: "guessed" }).success,
    ).toBe(false);
    expect(ompTeamRequestSchema.safeParse({ action: "stop", sessionId: "s" }).success).toBe(false);
    expect(ompTeamRunSchema.parse(run)).toEqual(run);
  });
  it("keeps same-model invocation slots separate and renders only native directed evidence", () => {
    const html = markup(run);
    expect(html).toContain('data-node-id="call-a"');
    expect(html).toContain('data-node-id="call-b"');
    expect(html.match(/data-testid="omp-team-edge"/gu)).toHaveLength(1);
    expect(html).toContain('data-source="call-b" data-target="call-a"');
    expect(html).toContain("No causal evidence for synthesis");
    expect(html).not.toContain("animate-pulse");
  });
  it("does not invent graph nodes for cold historical runs", () => {
    const html = markup({ ...run, nodes: [], edges: [], timeline: [], status: "unavailable" });
    expect(html).not.toContain('data-testid="omp-team-node"');
    expect(html).toContain("Native observation limits");
    expect(html).toContain("disabled");
  });
  it("stops animation and cancellation when connection is lost", () => {
    const live = {
      ...run,
      source: "native-live" as const,
      status: "running" as const,
      nodes: run.nodes.map((node) => ({ ...node, status: "running" })),
    };
    expect(markup(live)).toContain("motion-safe:animate-pulse");
    const html = markup(live, false);
    expect(html).not.toContain("animate-pulse");
    expect(html).toContain("Disconnected");
    expect(html).toContain("disabled");
  });
  it("keeps launch, configuration and all five stage labels visible without native availability", () => {
    const html = renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(TeamPage, { workspacePath: "/unavailable" }),
      }),
    );
    expect(html).toContain('data-testid="omp-team-configure"');
    expect(html).toContain('data-testid="omp-team-task"');
    expect(html).toContain('data-testid="omp-team-start"');
    expect(html).toContain('data-testid="omp-team-stages"');
    for (const label of ["Proposals", "Alignment", "Review", "Revision / recheck", "Synthesis"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Select a real session");
    expect(html).toContain("without inventing execution progress");
    expect(html).not.toContain('data-testid="omp-team-node"');
    expect(html).toContain("disabled");
  });
});
