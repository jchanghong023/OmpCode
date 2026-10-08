import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IBroadcastService } from "@zcode/services";
import type {
  ZCodeAgentInteractionAgent,
  ZCodeAgentInteractionEvent,
  ZCodeSessionAgentInteractionsResult,
} from "@zcode/shared";
import { OmpAgentInteractionGraph } from "../src/app-shell/OmpAgentInteractionGraph.js";
import { OmpAgentInteractionsView } from "../src/app-shell/OmpAgentInteractionsView.js";
import {
  InteractionHistory,
  InteractionMessageContent,
  InteractionTime,
} from "../src/app-shell/OmpInteractionEventPresentation.js";
import {
  buildOmpInteractionGraph,
  filterOmpInteractionEvents,
  resolveOmpInteractionSelection,
  INTERACTION_NODE_WIDTH,
} from "../src/app-shell/ompAgentInteractionViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { StoreProvider } from "../src/store/StoreProvider.js";

const agents: ZCodeAgentInteractionAgent[] = [
  { id: "main", label: "Coordinator" },
  { id: "alpha", label: "Alpha", parentAgentId: "main", status: "success" },
  { id: "beta", label: "Beta", parentAgentId: "main" },
  { id: "gamma", label: "Gamma", parentAgentId: "alpha" },
];
function event(
  id: string,
  fromAgentId: string,
  toAgentId: string,
  body = "same body",
): ZCodeAgentInteractionEvent {
  return {
    eventId: id,
    kind: "message",
    fromAgentId,
    toAgentId,
    body,
    source: "history",
    timeBasis: "unknown",
  };
}
const events = [
  event("one", "alpha", "beta"),
  event("two", "beta", "alpha"),
  event("three", "gamma", "main"),
];
const renderIntl = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, element));

test("12 个以上代理及嵌套层级均能显示，节点不重叠且未知端点不补造父关系", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    id: `child-${index}`,
    label: `Child ${index}`,
    parentAgentId: index < 8 ? "main" : `child-${index - 8}`,
  }));
  const graph = buildOmpInteractionGraph(
    [...agents, ...many],
    [...events, event("external", "unknown", "alpha")],
  );
  assert.equal(graph.nodes.length, 17);
  assert.equal(graph.nodes.find((node) => node.agent.id === "gamma")?.depth, 2);
  assert.equal(graph.nodes.find((node) => node.agent.id === "unknown")?.agent.known, false);
  assert.equal(
    graph.nodes.find((node) => node.agent.id === "unknown")?.agent.parentAgentId,
    undefined,
  );
  for (const node of graph.nodes) {
    assert.ok(node.x >= INTERACTION_NODE_WIDTH / 2);
    assert.ok(node.x <= graph.width - INTERACTION_NODE_WIDTH / 2);
    for (const other of graph.nodes) {
      if (node !== other && node.depth === other.depth)
        assert.ok(Math.abs(node.x - other.x) >= INTERACTION_NODE_WIDTH);
    }
  }
  for (const small of [agents, [agents[0]!, ...many.slice(0, 5)]]) {
    const compact = buildOmpInteractionGraph(small, [], { viewportWidth: 383 });
    assert.equal(compact.width, 383);
    assert.ok(
      compact.nodes.every(
        (node) => node.x - compact.nodeWidth / 2 >= 0 && node.x + compact.nodeWidth / 2 <= 383,
      ),
    );
    assert.ok(
      compact.nodes.every(
        (node) =>
          node.y - compact.nodeHeight / 2 >= 0 && node.y + compact.nodeHeight / 2 <= compact.height,
      ),
    );
    for (const node of compact.nodes) {
      for (const other of compact.nodes) {
        if (node !== other)
          assert.ok(
            Math.abs(node.x - other.x) >= compact.nodeWidth ||
              Math.abs(node.y - other.y) >= compact.nodeHeight,
          );
      }
    }
  }
  const four = buildOmpInteractionGraph(agents, events, { viewportWidth: 383 });
  assert.ok(four.height <= 320);
  assert.equal(four.nodes.find((node) => node.agent.id === "gamma")?.depth, 2);
});

test("同正文不同消息保持独立，双向连线保留实际方向且回复弧线分离", () => {
  const graph = buildOmpInteractionGraph(agents, [...events, event("four", "alpha", "beta")]);
  const outgoing = graph.routes.find(
    (route) => route.fromAgentId === "alpha" && route.toAgentId === "beta",
  )!;
  const reply = graph.routes.find(
    (route) => route.fromAgentId === "beta" && route.toAgentId === "alpha",
  )!;
  assert.deepEqual(
    outgoing.events.map((item) => item.eventId),
    ["one", "four"],
  );
  assert.notEqual(outgoing.path, reply.path);
  assert.ok(
    graph.hierarchy.some((edge) => edge.fromAgentId === "alpha" && edge.toAgentId === "gamma"),
  );
});

test("不完整父关系中的孤立环和自通信仍可读，不生成无效坐标", () => {
  const graph = buildOmpInteractionGraph(
    [
      { id: "a", label: "A", parentAgentId: "b" },
      { id: "b", label: "B", parentAgentId: "a" },
    ],
    [event("self", "a", "a")],
  );
  assert.equal(graph.nodes.length, 2);
  assert.equal(new Set(graph.nodes.map((node) => node.agent.id)).size, 2);
  assert.doesNotMatch(graph.routes[0].path, /NaN|Infinity/u);
});

test("搜索正文、代理名和回复身份，筛选后的选择只落在可见记录", () => {
  const records = [
    ...events,
    { ...event("four", "gamma", "beta", "Unique marker"), replyTo: "original-message" },
  ];
  assert.deepEqual(
    filterOmpInteractionEvents(records, agents, "unique MARKER", "").map((item) => item.eventId),
    ["four"],
  );
  assert.equal(filterOmpInteractionEvents(records, agents, "Alpha", "").length, 2);
  assert.equal(filterOmpInteractionEvents(records, agents, "original-message", "gamma").length, 1);
  const filtered = filterOmpInteractionEvents(records, agents, "Unique marker", "");
  assert.equal(resolveOmpInteractionSelection(filtered, "one")?.eventId, "four");
  assert.equal(resolveOmpInteractionSelection([], "one"), null);
  assert.equal(records[3].timestamp, undefined);
});

test("图按所选记录联动真实双方、父关系和方向，未激活时没有图", () => {
  const model = buildOmpInteractionGraph(agents, events);
  const html = renderIntl(
    createElement(OmpAgentInteractionGraph, { model, selected: events[0], active: true }),
  );
  assert.match(html, /data-agent-id="gamma"[^>]*data-parent-agent-id="alpha"/u);
  assert.match(
    html,
    /data-message-id="one"[^>]*data-from="alpha"[^>]*data-to="beta"[^>]*data-selected="true"/u,
  );
  assert.match(html, /marker-end="url\(#[^)]+-selected\)"/u);
  assert.equal(
    renderIntl(
      createElement(OmpAgentInteractionGraph, { model, selected: events[0], active: false }),
    ),
    "",
  );
});

test("非活动页面不创建 Hero、消息列表或画布", () => {
  const result: ZCodeSessionAgentInteractionsResult = {
    rootSessionId: "root",
    revision: 1,
    agents,
    events,
    coverage: { status: "partial", issues: ["missing_timestamp"] },
    totalEvents: events.length,
  };
  assert.equal(
    renderIntl(
      createElement(OmpAgentInteractionsView, {
        result,
        active: false,
        loading: false,
        error: null,
        onRefresh() {},
      }),
    ),
    "",
  );
});

test("OMP 原生终态与 cold 未确认状态本地化，新状态保留源事实", () => {
  const model = buildOmpInteractionGraph(
    [
      { id: "main", label: "Coordinator", status: "completed" },
      { id: "child", label: "Child", parentAgentId: "main", status: "aborted" },
      { id: "cold", label: "Cold historical child", parentAgentId: "main", status: "unknown" },
      { id: "unknown-status", label: "Unknown", parentAgentId: "main", status: "future-status" },
    ],
    [],
  );
  for (const [locale, completed, aborted] of [
    ["zh-CN", "已完成", "已中止"],
    ["en-US", "Completed", "Aborted"],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(OmpAgentInteractionGraph, { model, selected: null, active: true }),
      ),
    );
    assert.ok(html.includes(completed));
    assert.ok(html.includes(aborted));
    assert.ok(html.includes("future-status"));
    assert.ok(html.includes(locale === "zh-CN" ? "状态未确认" : "Status unconfirmed"));
    assert.doesNotMatch(html, /运行中|Running|status\.completed|status\.aborted/u);
  }
});

test("空权威记录只生成空图与空选择，不补造代理或消息", () => {
  const model = buildOmpInteractionGraph([], []);
  assert.deepEqual(model.nodes, []);
  assert.deepEqual(model.routes, []);
  assert.deepEqual(model.hierarchy, []);
  assert.equal(resolveOmpInteractionSelection([], null), null);
});

test("未知时间依据即使带观测数值也不会冒充发送或记录时间", () => {
  const html = renderIntl(
    createElement(InteractionTime, {
      event: { ...event("unknown-basis", "alpha", "beta"), timestamp: 1000 },
    }),
  );
  assert.match(html, /时间未知/u);
  assert.doesNotMatch(html, /<time|发送时间|记录时间/u);
});

test("任务结果默认展示少量真实字段，完整包装和机器标记只在关闭的原文中", () => {
  const body = `<task-result id="worker" status="completed" duration="17.4s">
<output>{"status":"ANALYSIS_READY","lookup_result":"EVIDENCE_FOUND","messages_sent":["trace-mark-1","trace-mark-2"],"trace_marker":"machine"}</output>
</task-result>
worker is now idle — message it via write agent://worker; transcript at history://worker`;
  const record = { ...event("task-summary", "alpha", "main", body), kind: "task_result" as const };
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(InteractionMessageContent, { event: record }),
      ),
    );
    const visible = html.replace(/<details\b[\s\S]*?<\/details>/gu, "");
    assert.ok(visible.includes(locale === "zh-CN" ? "已完成" : "Completed"));
    assert.ok(visible.includes(locale === "zh-CN" ? "17.4 秒" : "17.4s"));
    assert.ok(visible.includes("ANALYSIS_READY"));
    assert.ok(visible.includes("EVIDENCE_FOUND"));
    assert.ok(visible.includes(locale === "zh-CN" ? "报告发送" : "Reported sent"));
    assert.ok(visible.includes(locale === "zh-CN" ? "2 条" : "2 messages"));
    assert.doesNotMatch(visible, /task-result|trace_marker|trace-mark|write agent|history:\/\//u);
    assert.match(html, /data-testid="omp-agent-interaction-raw"/u);
    assert.doesNotMatch(html, /<details\b[^>]*\bopen(?:[=\s>])/u);
    assert.ok(html.includes(locale === "zh-CN" ? "查看原文" : "View original"));
    assert.ok(html.includes("&lt;task-result"));
    assert.ok(html.includes("trace_marker"));
  }
  const list = renderIntl(
    createElement(InteractionHistory, {
      events: [record],
      labels: new Map(agents.map((agent) => [agent.id, agent.label])),
      onSelect() {},
    }),
  );
  assert.doesNotMatch(list, /task-result|trace_marker|trace-mark|write agent|history:\/\//u);
  assert.match(list, /ANALYSIS_READY/u);
  assert.equal(record.body, body);
});

test("普通短消息保持原文，长消息的摘要与关闭原文分别显示", () => {
  const short = "已核对入口和调用链，请继续验证。";
  const html = renderIntl(
    createElement(InteractionMessageContent, { event: event("short", "alpha", "beta", short) }),
  );
  assert.ok(html.includes(short));
  assert.doesNotMatch(html, /<details/u);
  const long = Array.from({ length: 80 }, (_, index) => `进展 ${index} 已核对入口。`).join("\n");
  const longHtml = renderIntl(
    createElement(InteractionMessageContent, { event: event("long", "alpha", "beta", long) }),
  );
  const visible = longHtml.replace(/<details\b[\s\S]*?<\/details>/gu, "");
  assert.ok(visible.includes("进展 0"));
  assert.ok(!visible.includes("进展 79"));
  assert.ok(longHtml.includes("进展 79"));
  assert.doesNotMatch(longHtml, /<details\b[^>]*\bopen(?:[=\s>])/u);
});

test("静态展示保留正文、未知时间与记录时间，并安全渲染消息内容", (context) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  // StoreProvider 初始化需要主题根节点；这里不提供 GPU/平台桥，真实展示走静态 JSX。
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: {
        classList: { toggle() {} },
        hasAttribute: () => false,
        style: { setProperty() {} },
      },
    },
  });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const records = [
    { ...event("unknown", "alpha", "beta"), body: "no time" },
    {
      ...event("recorded", "beta", "main", '<script>alert("unsafe")</script>'),
      timestamp: 1000,
      timeBasis: "recorded" as const,
    },
  ];
  const result: ZCodeSessionAgentInteractionsResult = {
    rootSessionId: "root",
    revision: 1,
    agents,
    events: records,
    coverage: { status: "partial", issues: ["missing_timestamp", "legacy_history_gaps"] },
    totalEvents: 4,
    nextCursor: "2",
  };
  const broadcast = {
    send() {},
    onMessage: () => ({ dispose() {} }),
  } as unknown as IBroadcastService;
  const html = renderIntl(
    createElement(
      StoreProvider,
      { broadcastService: broadcast },
      createElement(OmpAgentInteractionsView, {
        result,
        loading: false,
        error: null,
        onRefresh() {},
        onLoadMore() {},
      }),
    ),
  );
  assert.match(
    html,
    /data-testid="omp-agent-interaction-detail"[^>]*data-from="beta"[^>]*data-to="main"[^>]*data-time-basis="recorded"/u,
  );
  assert.ok(html.includes("&lt;script&gt;"));
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /时间未知/u);
  assert.match(html, /记录时间/u);
  assert.match(html, /data-testid="omp-agent-interactions-coverage"/u);
  assert.match(html, /data-testid="omp-agent-interactions-search"/u);
  assert.match(html, /加载更多/u);
});
