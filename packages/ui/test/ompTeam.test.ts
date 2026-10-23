// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ompTeamRequestSchema, ompTeamRunSchema, type OmpTeamRun } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/index.js";
import { TeamChatCard, TeamRunView } from "../src/omp-configuration/TeamRunView.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const run: OmpTeamRun = {
  jobId: "job-1",
  sessionId: "session-1",
  dispatchEntityId: "dispatch-1",
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
  it("opens native details from an anchored chat card without issuing execution or cancellation", () => {
    const onOpenDetails = vi.fn();
    const onStop = vi.fn();
    render(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(TooltipProvider, {
          children: createElement(TeamChatCard, {
            run: { ...run, report: "Final native proposal: preserve the existing project." },
            connected: true,
            busy: false,
            onOpenDetails,
            onStop,
          }),
        }),
      }),
    );
    const card = screen.getByTestId("omp-team-chat-card");
    expect(card.getAttribute("data-job-id")).toBe(run.jobId);
    expect(card.getAttribute("data-status")).toBe("completed");
    expect(
      within(card)
        .getByText("Final native proposal: preserve the existing project.")
        .closest("details"),
    ).toBeNull();
    fireEvent.click(within(card).getByTestId("workflow-card-open-details"));
    expect(onOpenDetails).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
  });
  it("keeps unavailable native cards visible with a reason instead of inventing a workflow run", () => {
    const html = renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(TooltipProvider, {
          children: createElement(TeamChatCard, {
            run: { ...run, status: "unavailable", nodes: [], edges: [] },
            connected: false,
            busy: false,
            error: "Native Team journal is not available on this connection",
            onOpenDetails: () => {},
          }),
        }),
      }),
    );
    expect(html).toContain('data-testid="omp-team-chat-card"');
    expect(html).toContain("Native Team journal is not available on this connection");
    expect(html).not.toContain('data-testid="omp-team-start"');
  });
  afterEach(cleanup);
  it("shows structured native output and tool data without opening raw observations", () => {
    const proposal = {
      proposal: "OMP_E2E_TEAM_PROPOSAL: inspect only; preserve source files.",
      acceptanceCriteria: ["No file changes"],
      approved: false,
      revision: 1,
    };
    const value: OmpTeamRun = {
      ...run,
      nodes: [
        {
          ...run.nodes[0]!,
          output: proposal,
          tools: [{ name: "yield", arguments: { data: proposal } }],
          messages: [
            {
              role: "toolResult",
              content: [{ type: "text", text: "Result submitted." }],
              details: {
                data: { reportMarkdown: "Inspection report", reviewSummary: "No changes needed" },
              },
            },
          ],
        },
      ],
      edges: [],
    };
    render(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(TeamRunView, {
          run: value,
          connected: true,
          busy: false,
          onStop: () => {},
        }),
      }),
    );
    fireEvent.click(screen.getByTestId("omp-team-node"));
    const detail = screen.getByTestId("omp-team-node-detail");
    const output = within(detail).getByText("Output").parentElement!;
    expect(within(output).getByText(proposal.proposal).closest("details")).toBeNull();
    expect(within(output).getByText("No file changes").closest("li")).not.toBeNull();
    expect(within(output).getByText("false").closest("pre")).toBeNull();
    expect(within(output).getByText("1").closest("pre")).toBeNull();
    const raw = within(output).getByText("View raw observation").closest("details")!;
    expect(raw.open).toBe(false);
    expect(JSON.parse(raw.querySelector("pre")!.textContent!)).toEqual(proposal);
    const tool = within(detail).getByText("yield", { selector: "summary" }).closest("details")!;
    fireEvent.click(within(tool).getByText("yield", { selector: "summary" }));
    expect(tool.open).toBe(true);
    expect(within(tool).getByText(proposal.proposal).closest("details")).toBe(tool);
    expect(within(tool).getByText("No file changes").closest("li")).not.toBeNull();
    for (const text of ["Result submitted.", "Inspection report", "No changes needed"]) {
      expect(within(detail).getByText(text).closest("details")).toBeNull();
    }
  });
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
    expect(html).toContain('data-active="false"');
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
    const onStop = vi.fn();
    const view = render(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(TeamRunView, {
          run: live,
          connected: true,
          busy: false,
          onStop,
        }),
      }),
    );
    const stop = view.getByTestId("omp-team-stop");
    expect(stop.matches(":disabled")).toBe(false);
    const edge = view.getByTestId("omp-team-edge");
    expect(edge.querySelector("[data-active]")?.getAttribute("data-active")).toBe("true");
    view.rerender(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(TeamRunView, {
          run: live,
          connected: false,
          busy: false,
          onStop,
        }),
      }),
    );
    expect(edge.querySelector("[data-active]")?.getAttribute("data-active")).toBe("false");
    expect(view.getByTestId("omp-team-stop").matches(":disabled")).toBe(true);
    fireEvent.click(view.getByTestId("omp-team-stop"));
    expect(onStop).not.toHaveBeenCalled();
  });
});
