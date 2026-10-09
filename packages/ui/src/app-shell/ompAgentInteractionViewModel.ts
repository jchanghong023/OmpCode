import type { ZCodeAgentInteractionAgent, ZCodeAgentInteractionEvent } from "@zcode/shared";

export const INTERACTION_NODE_WIDTH = 156;
const INTERACTION_NODE_HEIGHT = 72;

interface OmpInteractionNode {
  agent: ZCodeAgentInteractionAgent;
  x: number;
  y: number;
  depth: number;
}

interface OmpInteractionRoute {
  fromAgentId: string;
  toAgentId: string;
  events: readonly ZCodeAgentInteractionEvent[];
  path: string;
}

export interface OmpInteractionGraphModel {
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  nodes: readonly OmpInteractionNode[];
  routes: readonly OmpInteractionRoute[];
  hierarchy: readonly { fromAgentId: string; toAgentId: string; path: string }[];
}

function routePath(
  from: OmpInteractionNode,
  to: OmpInteractionNode,
  nodeWidth: number,
  nodeHeight: number,
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!dx && !dy) {
    const right = from.x + nodeWidth / 2;
    return `M ${right} ${from.y - 12} C ${right + 72} ${from.y - 80}, ${right + 72} ${from.y + 80}, ${right} ${from.y + 12}`;
  }
  const scale = Math.min(
    (nodeWidth / 2 + 6) / Math.abs(dx || 0.001),
    (nodeHeight / 2 + 6) / Math.abs(dy || 0.001),
  );
  const start = { x: from.x + dx * scale, y: from.y + dy * scale };
  const end = { x: to.x - dx * scale, y: to.y - dy * scale };
  if (!dy) {
    // 双向通信使用相反的弧线，避免回复的箭头与原消息重叠。
    const bend = dx > 0 ? -36 : 36;
    return `M ${start.x} ${start.y} C ${start.x + dx / 3} ${start.y + bend}, ${end.x - dx / 3} ${end.y + bend}, ${end.x} ${end.y}`;
  }
  const midpoint = (start.y + end.y) / 2;
  // 上行回信稍向外偏移；任务关系与真实消息采用不同线型。
  const bend = dy < 0 ? (dx >= 0 ? -22 : 22) : 0;
  return `M ${start.x} ${start.y} C ${start.x + bend} ${midpoint}, ${end.x + bend} ${midpoint}, ${end.x} ${end.y}`;
}

/** 纯展示派生：不改写权威事件的身份、时间、正文或顺序。 */
export function buildOmpInteractionGraph(
  agents: readonly ZCodeAgentInteractionAgent[],
  events: readonly ZCodeAgentInteractionEvent[],
  options: { viewportWidth?: number } = {},
): OmpInteractionGraphModel {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const event of events) {
    for (const id of [event.fromAgentId, event.toAgentId]) {
      if (!byId.has(id)) byId.set(id, { id, label: id, known: false });
    }
  }
  const children = new Map<string, ZCodeAgentInteractionAgent[]>();
  const roots: ZCodeAgentInteractionAgent[] = [];
  for (const agent of byId.values()) {
    const parentId = agent.parentAgentId;
    if (agent.id !== "main" && parentId && parentId !== agent.id && byId.has(parentId)) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(agent);
      children.set(parentId, siblings);
    } else roots.push(agent);
  }
  roots.sort((a, b) => Number(b.id === "main") - Number(a.id === "main"));
  const levels: ZCodeAgentInteractionAgent[][] = [];
  const seen = new Set<string>();
  const visit = (root: ZCodeAgentInteractionAgent) => {
    const queue = [{ agent: root, depth: 0 }];
    for (let index = 0; index < queue.length; index++) {
      const candidate = queue[index];
      if (!candidate) continue;
      const { agent, depth } = candidate;
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      (levels[depth] ??= []).push(agent);
      for (const child of children.get(agent.id) ?? []) {
        if (!seen.has(child.id)) queue.push({ agent: child, depth: depth + 1 });
      }
    }
  };
  roots.forEach(visit);
  // 不完整的历史可能含孤立环；仍显示真实节点，不凭层级猜测消息。
  for (const agent of byId.values()) if (!seen.has(agent.id)) visit(agent);
  const breadth = Math.max(1, ...levels.map((level) => level.length));
  const compact = byId.size <= 6;
  const width =
    compact && options.viewportWidth
      ? Math.max(188, options.viewportWidth)
      : Math.max(440, (breadth + 1) * 196);
  const nodeWidth = Math.min(INTERACTION_NODE_WIDTH, width - 32);
  const nodeHeight = compact ? 64 : INTERACTION_NODE_HEIGHT;
  const columns = compact ? Math.max(1, Math.floor((width - 12) / (nodeWidth + 20))) : breadth;
  const rowPitch = compact ? 108 : 148;
  let rowOffset = 0;
  const nodes = levels.flatMap((level, depth) => {
    const items = level.map((agent, index) => {
      const row = Math.floor(index / columns);
      const count = Math.min(columns, level.length - row * columns);
      const rowWidth = count * nodeWidth + (count - 1) * 20;
      return {
        agent,
        depth,
        x: (width - rowWidth) / 2 + nodeWidth / 2 + (index % columns) * (nodeWidth + 20),
        y: 16 + nodeHeight / 2 + (rowOffset + row) * rowPitch,
      };
    });
    rowOffset += Math.ceil(level.length / columns);
    return items;
  });
  const height = Math.max(252, 32 + nodeHeight + Math.max(0, rowOffset - 1) * rowPitch);
  const positions = new Map(nodes.map((node) => [node.agent.id, node]));
  const grouped = new Map<string, ZCodeAgentInteractionEvent[]>();
  for (const event of events) {
    const key = JSON.stringify([event.fromAgentId, event.toAgentId]);
    const route = grouped.get(key) ?? [];
    route.push(event);
    grouped.set(key, route);
  }
  const routes = [...grouped.values()].flatMap((items) => {
    const first = items[0];
    if (!first) return [];
    const from = positions.get(first.fromAgentId);
    const to = positions.get(first.toAgentId);
    if (!from || !to) return [];
    return [
      {
        fromAgentId: first.fromAgentId,
        toAgentId: first.toAgentId,
        events: items,
        path: routePath(from, to, nodeWidth, nodeHeight),
      },
    ];
  });
  const hierarchy = nodes.flatMap((node) => {
    const parent = positions.get(node.agent.parentAgentId ?? "");
    return parent && parent !== node
      ? [
          {
            fromAgentId: parent.agent.id,
            toAgentId: node.agent.id,
            path: routePath(parent, node, nodeWidth, nodeHeight),
          },
        ]
      : [];
  });
  return { width, height, nodeWidth, nodeHeight, nodes, routes, hierarchy };
}

export function filterOmpInteractionEvents(
  events: readonly ZCodeAgentInteractionEvent[],
  agents: readonly ZCodeAgentInteractionAgent[],
  query: string,
  agentId: string,
): ZCodeAgentInteractionEvent[] {
  const search = query.trim().toLocaleLowerCase();
  const labels = new Map(agents.map((agent) => [agent.id, agent.label]));
  return events.filter((event) => {
    if (agentId && event.fromAgentId !== agentId && event.toAgentId !== agentId) return false;
    if (!search) return true;
    return [
      event.body,
      event.fromAgentId,
      event.toAgentId,
      labels.get(event.fromAgentId),
      labels.get(event.toAgentId),
      event.messageId,
      event.replyTo,
    ].some((text) => text?.toLocaleLowerCase().includes(search));
  });
}

/** 过滤不保留已不可见的选择，也不把 UI 选择写入会话事实。 */
export function resolveOmpInteractionSelection(
  events: readonly ZCodeAgentInteractionEvent[],
  selectedId: string | null,
): ZCodeAgentInteractionEvent | null {
  return events.find((event) => event.eventId === selectedId) ?? events.at(-1) ?? null;
}
