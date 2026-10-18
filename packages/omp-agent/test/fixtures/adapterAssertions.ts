import assert from "node:assert/strict";
import { z } from "zod";
import { conversationTopicWireFrameSchema } from "@zcode/shared/zcode-protocol-v4";
import type { RealOmpHarness } from "./realOmpHarness.js";

export const callSchema = z.object({
  context: z.object({
    messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  }),
});

export function imageSources(content: unknown): unknown[] {
  if (typeof content === "string") return [];
  return z
    .array(z.looseObject({ type: z.string() }))
    .parse(content)
    .filter((block) => block.type === "image")
    .map((block) => block.source);
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  return z
    .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
    .parse(content)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export function assertWireAndOrdinals(harness: RealOmpHarness, subscriptionId: string): void {
  const logical = new Map<string, number>();
  for (const frame of harness.frames) {
    if (frame.method !== "v4/conversation/frame") continue;
    const wire = conversationTopicWireFrameSchema.parse(frame.params);
    if (wire.subscriptionId === subscriptionId) {
      logical.set(wire.logicalFrameId, wire.logicalFrameOrdinal);
    }
  }
  const ordinals = [...logical.values()];
  assert.ok(ordinals.length > 1, "真实会话必须发布快照及后续增量");
  assert.deepEqual(
    ordinals,
    ordinals.map((_, index) => index + 1),
  );
}
