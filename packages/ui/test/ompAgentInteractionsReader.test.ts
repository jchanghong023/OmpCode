import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeSessionAgentInteractionsResult } from "@zcode/shared";
import {
  createOmpAgentInteractionsReader,
  type OmpAgentInteractionsReadState,
} from "../src/lib/OmpAgentInteractionsReader.js";

function page(
  ids: string[],
  options: Partial<ZCodeSessionAgentInteractionsResult> = {},
): ZCodeSessionAgentInteractionsResult {
  return {
    rootSessionId: "root",
    revision: 1,
    agents: [],
    events: ids.map((eventId) => ({
      eventId,
      kind: "message",
      fromAgentId: "a",
      toAgentId: "b",
      body: eventId,
      source: "history",
      timeBasis: "unknown",
    })),
    coverage: { status: "partial", issues: ["legacy_history_gaps"] },
    totalEvents: ids.length,
    ...options,
  };
}

test("queries singleflight with one trailing refresh and discard results on close/scope change", async () => {
  const calls: ((value: ZCodeSessionAgentInteractionsResult) => void)[] = [];
  const states: OmpAgentInteractionsReadState[] = [];
  const reader = createOmpAgentInteractionsReader({
    query: () => new Promise((resolve) => calls.push(resolve)),
    publish: (state) => states.push(state),
  });
  const first = reader.refresh();
  void reader.refresh();
  void reader.refresh();
  assert.equal(calls.length, 1);
  calls[0]!(page(["first"]));
  await first;
  assert.equal(calls.length, 2);
  const countAtClose = states.length;
  reader.dispose();
  calls[1]!(page(["late-old-scope"]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.length, countAtClose);
  await reader.refresh();
  assert.equal(calls.length, 2);
});

test("pagination deduplicates event identity and refresh preserves all loaded pages", async () => {
  const states: OmpAgentInteractionsReadState[] = [];
  const requests: (string | undefined)[] = [];
  const reader = createOmpAgentInteractionsReader({
    query: async (cursor) => {
      requests.push(cursor);
      return cursor
        ? page(["b", "c"], { totalEvents: 501 })
        : page(["a", "b", ...Array.from({ length: 498 }, (_, i) => `event-${i}`)], {
            totalEvents: 501,
            nextCursor: "next-page",
          });
    },
    publish: (state) => states.push(state),
  });
  await reader.refresh();
  assert.equal(states.at(-1)!.result!.events.length, 500);
  assert.equal(states.at(-1)!.result!.nextCursor, "next-page");
  await reader.loadMore();
  assert.equal(requests.length, 2);
  const previousResult = states.at(-1)!.result;
  assert.equal(previousResult!.events.length, 501);
  assert.equal(previousResult!.events.at(-1)!.eventId, "c");
  await reader.refresh();
  assert.equal(states.at(-1)!.result, previousResult);
  reader.dispose();
});

test("changed cursor snapshot does not append another revision to loaded messages", async () => {
  const states: OmpAgentInteractionsReadState[] = [];
  const reader = createOmpAgentInteractionsReader({
    query: async (cursor) =>
      cursor
        ? page(["unrelated-new-page"], { revision: 2 })
        : page(
            Array.from({ length: 500 }, (_, i) => `first-${i}`),
            { totalEvents: 501, nextCursor: "old-page" },
          ),
    publish: (state) => states.push(state),
  });
  await reader.refresh();
  await reader.loadMore();
  assert.equal(states.at(-1)!.error, "agent_interactions_page_changed");
  assert.equal(states.at(-1)!.result!.events.length, 500);
  assert.equal(
    states.at(-1)!.result!.events.some((event) => event.eventId === "unrelated-new-page"),
    false,
  );
  reader.dispose();
});

test("unavailable or changed cursor snapshots preserve prior data and expose error", async () => {
  let fail = false;
  const states: OmpAgentInteractionsReadState[] = [];
  const reader = createOmpAgentInteractionsReader({
    query: async () => {
      if (fail) throw new Error("record_unavailable");
      return page(["known"]);
    },
    publish: (state) => states.push(state),
  });
  await reader.refresh();
  fail = true;
  await reader.refresh();
  assert.equal(states.at(-1)!.result!.events[0]!.eventId, "known");
  assert.equal(states.at(-1)!.error, "record_unavailable");
  reader.dispose();
});

test("hidden view starts no query and drops pending trailing reads", async () => {
  let visible = false;
  let calls = 0;
  const reader = createOmpAgentInteractionsReader({
    query: async () => {
      calls++;
      return page([]);
    },
    canRead: () => visible,
    publish() {},
  });
  await reader.refresh();
  await reader.loadMore();
  assert.equal(calls, 0);
  visible = true;
  await reader.refresh();
  assert.equal(calls, 1);
  reader.dispose();
});

test("load-more requested during slow polling is queued ahead of the trailing refresh", async () => {
  const states: OmpAgentInteractionsReadState[] = [];
  const pending: {
    cursor?: string;
    resolve: (value: ZCodeSessionAgentInteractionsResult) => void;
  }[] = [];
  const firstPage = page(
    Array.from({ length: 500 }, (_, i) => `first-${i}`),
    { totalEvents: 501, nextCursor: "next" },
  );
  const reader = createOmpAgentInteractionsReader({
    query: (cursor) => new Promise((resolve) => pending.push({ cursor, resolve })),
    publish: (state) => states.push(state),
  });
  const initial = reader.refresh();
  pending[0]!.resolve(firstPage);
  await initial;
  const slowRefresh = reader.refresh();
  void reader.refresh();
  void reader.loadMore();
  assert.equal(states.at(-1)!.loadingMore, true);
  pending[1]!.resolve(firstPage);
  await slowRefresh;
  assert.equal(pending[2]!.cursor, "next");
  pending[2]!.resolve(page(["last"], { totalEvents: 501 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1)!.result!.events.length, 501);
  assert.equal(pending[3]!.cursor, undefined);
  reader.dispose();
  pending[3]!.resolve(firstPage);
});
