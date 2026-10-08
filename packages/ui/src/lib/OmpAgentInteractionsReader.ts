import type { ZCodeSessionAgentInteractionsResult } from "@zcode/shared";

export interface OmpAgentInteractionsReadState {
  result: ZCodeSessionAgentInteractionsResult | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

export const EMPTY_OMP_AGENT_INTERACTIONS_STATE: OmpAgentInteractionsReadState = {
  result: null,
  loading: true,
  loadingMore: false,
  error: null,
};

/** 活动页的只读调度器；关闭即撤销结果应用，不拥有通信事实。 */
export function createOmpAgentInteractionsReader(options: {
  query: (cursor?: string) => Promise<ZCodeSessionAgentInteractionsResult>;
  publish: (state: OmpAgentInteractionsReadState) => void;
  canRead?: () => boolean;
}) {
  let state = EMPTY_OMP_AGENT_INTERACTIONS_STATE;
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let trailingRefresh = false;
  let trailingMore = false;
  let loadedCount = 500;

  function publish(next: OmpAgentInteractionsReadState) {
    if (disposed) return;
    state = next;
    options.publish(next);
  }

  async function read(mode: "refresh" | "more") {
    const cursor = mode === "more" ? state.result?.nextCursor : undefined;
    if (mode === "more" && !cursor) return;
    publish({ ...state, loading: !state.result, loadingMore: mode === "more", error: null });
    try {
      let page = await options.query(cursor);
      if (disposed || options.canRead?.() === false) return;
      const previous = state.result;
      if (
        cursor &&
        previous &&
        (page.revision !== previous.revision || page.rootSessionId !== previous.rootSessionId)
      ) {
        throw new Error("agent_interactions_page_changed");
      }
      let events = cursor && previous ? [...previous.events, ...page.events] : page.events;
      const seenCursors = new Set<string>();
      while (mode === "refresh" && page.nextCursor && events.length < loadedCount) {
        if (seenCursors.has(page.nextCursor)) throw new Error("agent_interactions_cursor_repeated");
        seenCursors.add(page.nextCursor);
        const next = await options.query(page.nextCursor);
        if (disposed || options.canRead?.() === false) return;
        if (next.revision !== page.revision || next.rootSessionId !== page.rootSessionId) {
          throw new Error("agent_interactions_page_changed");
        }
        events = [...events, ...next.events];
        page = next;
      }
      const eventIds = new Set<string>();
      events = events.filter((event) => {
        if (eventIds.has(event.eventId)) return false;
        eventIds.add(event.eventId);
        return true;
      });
      loadedCount = Math.max(500, events.length);
      const result =
        previous &&
        previous.rootSessionId === page.rootSessionId &&
        previous.revision === page.revision &&
        previous.events.length === events.length &&
        previous.nextCursor === page.nextCursor &&
        previous.totalEvents === page.totalEvents
          ? previous
          : { ...page, events };
      publish({ result, loading: false, loadingMore: false, error: null });
    } catch (error) {
      publish({
        ...state,
        loading: false,
        loadingMore: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function request(mode: "refresh" | "more"): Promise<void> {
    if (disposed || options.canRead?.() === false) return Promise.resolve();
    if (inFlight) {
      if (mode === "refresh") trailingRefresh = true;
      else {
        // 刷新未结束时“加载更多”仍须被接纳，不能因轮询一直在途而丢掉用户读取下一页的请求。
        trailingMore = true;
        publish({ ...state, loadingMore: true });
      }
      return inFlight;
    }
    inFlight = read(mode).finally(() => {
      inFlight = null;
      if (trailingMore && !disposed) {
        trailingMore = false;
        void request("more");
      } else if (trailingRefresh && !disposed) {
        trailingRefresh = false;
        void request("refresh");
      }
    });
    return inFlight;
  }

  return {
    refresh: () => request("refresh"),
    loadMore: () => request("more"),
    dispose() {
      disposed = true;
      trailingRefresh = false;
      trailingMore = false;
    },
  };
}
