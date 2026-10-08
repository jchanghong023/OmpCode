import type { ZCodeAgentInteractionCoverage, ZCodeAgentInteractionEvent } from "@zcode/shared";
import type { InteractionObservation } from "./OmpAgentInteractionRecords.js";

type Issue = ZCodeAgentInteractionCoverage["issues"][number];
const identity = (event: ZCodeAgentInteractionEvent) =>
  `${event.fromAgentId}\0${event.toAgentId}\0${event.body}`;
function combinedSource(
  left: ZCodeAgentInteractionEvent["source"],
  right: ZCodeAgentInteractionEvent["source"],
): ZCodeAgentInteractionEvent["source"] {
  return left === right ? left : "live_and_history";
}
function mergeObservation(
  prior: InteractionObservation,
  next: InteractionObservation,
): InteractionObservation {
  const priorTime = prior.event.timeBasis === "sent" || next.event.timestamp === undefined;
  return {
    ...next,
    startTimestamp: next.startTimestamp ?? prior.startTimestamp,
    endTimestamp: next.endTimestamp ?? prior.endTimestamp,
    event: {
      ...prior.event,
      ...next.event,
      ...(priorTime ? { timestamp: prior.event.timestamp, timeBasis: prior.event.timeBasis } : {}),
      source: combinedSource(prior.event.source, next.event.source),
      ...(next.event.delivery === "observed" &&
      prior.event.delivery &&
      prior.event.delivery !== "unknown"
        ? { delivery: prior.event.delivery }
        : {}),
    },
  };
}

/** ID 是幂等键。无 ID 的同源相同正文保持独立，仅归并无歧义的跨源真实观察。 */
export function mergeInteractionObservations(
  observations: readonly InteractionObservation[],
  issues: Set<Issue>,
): ZCodeAgentInteractionEvent[] {
  const merged = new Map<string, InteractionObservation>();
  for (const observation of observations) {
    const event = observation.event;
    const prior = merged.get(event.eventId);
    if (!prior) merged.set(event.eventId, observation);
    else if (identity(prior.event) === identity(event) && prior.event.kind === event.kind)
      merged.set(event.eventId, mergeObservation(prior, observation));
    else {
      issues.add("ambiguous_identity");
      merged.set(`${event.eventId}:${merged.size}`, {
        ...observation,
        event: { ...event, eventId: `${event.eventId}:${merged.size}` },
      });
    }
  }
  const identified = [...merged.values()].filter((item) => item.event.messageId);
  const unidentified = [...merged.values()].filter(
    (item) => item.event.kind === "message" && !item.event.messageId,
  );
  for (const item of unidentified) {
    const candidates = identified.filter((target) => {
      if (identity(item.event) !== identity(target.event)) return false;
      if (item.origin === "relay")
        return (
          item.event.timeBasis === "sent" &&
          target.event.timeBasis === "sent" &&
          item.event.timestamp === target.event.timestamp
        );
      if (item.origin !== "send" || item.event.delivery === "failed") return false;
      const time = target.event.timestamp;
      return (
        time !== undefined &&
        target.event.timeBasis === "sent" &&
        item.startTimestamp !== undefined &&
        item.endTimestamp !== undefined &&
        time >= item.startTimestamp &&
        time <= item.endTimestamp
      );
    });
    // 两条相同发送或转发不能凭正文猜测归属；互为唯一候选才承认同一次观察。
    const competing =
      candidates.length === 1
        ? unidentified.filter(
            (other) =>
              other !== item &&
              other.origin === item.origin &&
              identity(other.event) === identity(item.event) &&
              (other.origin === "relay"
                ? other.event.timestamp === candidates[0]!.event.timestamp
                : other.origin === "send" &&
                  other.startTimestamp !== undefined &&
                  other.endTimestamp !== undefined &&
                  candidates[0]!.event.timestamp !== undefined &&
                  candidates[0]!.event.timestamp! >= other.startTimestamp &&
                  candidates[0]!.event.timestamp! <= other.endTimestamp),
          )
        : [];
    if (candidates.length === 1 && competing.length === 0) {
      const target = merged.get(candidates[0]!.event.eventId) ?? candidates[0]!;
      const mergedTarget = mergeObservation(item, target);
      merged.set(target.event.eventId, {
        ...mergedTarget,
        event: {
          ...mergedTarget.event,
          ...(item.event.broadcastGroupId ? { broadcastGroupId: item.event.broadcastGroupId } : {}),
          ...(item.event.delivery && item.event.delivery !== "observed"
            ? { delivery: item.event.delivery }
            : {}),
        },
      });
      merged.delete(item.event.eventId);
    } else if (candidates.length > 0 || item.origin === "relay") issues.add("ambiguous_identity");
  }
  const events = [...merged.values()].map((item) => item.event);
  if (events.some((event) => event.timestamp === undefined)) issues.add("missing_timestamp");
  return events.sort(
    (left, right) =>
      (left.timestamp ?? Number.MAX_SAFE_INTEGER) - (right.timestamp ?? Number.MAX_SAFE_INTEGER) ||
      left.eventId.localeCompare(right.eventId),
  );
}
