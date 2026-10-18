import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { prepareRealOmpFixture, RealOmpHarness } from "./realOmpHarness.js";

const clockMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("test:attachment-clock-ready"), now: z.number().int() }),
  z.object({
    type: z.literal("test:attachment-clock-advanced"),
    before: z.number().int(),
    now: z.number().int(),
  }),
]);

export async function startRealOmpAttachmentClock(handler: unknown) {
  const fixture = await prepareRealOmpFixture({ handler });
  let h: RealOmpHarness | undefined;
  try {
    const child = spawn(
      fixture.launch.command,
      [
        "--import",
        new URL("./attachmentExpiryClock.mjs", import.meta.url).href,
        ...fixture.launch.args,
      ],
      {
        cwd: fixture.launch.cwd,
        env: fixture.launch.env,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    ) as ChildProcessWithoutNullStreams; // fd 0/1/2 are explicitly configured as pipes.
    const messages: z.infer<typeof clockMessageSchema>[] = [];
    child.on("message", (message) => messages.push(clockMessageSchema.parse(message)));
    h = new RealOmpHarness(child, fixture.root, fixture.workspace, fixture.mock, () =>
      fixture.close(),
    );
    const ready = await h.waitUntil(() =>
      messages.find((message) => message.type === "test:attachment-clock-ready"),
    );
    let now = ready.now;
    await h.waitUntil(() =>
      h!.frames.find(
        (frame) =>
          frame.method === "startup/storageState" &&
          z.object({ phase: z.string() }).parse(frame.params).phase === "ready",
      ),
    );
    const harness = h;
    return {
      h: harness,
      now: () => now,
      async advanceBy(milliseconds: number) {
        assert.ok(Number.isSafeInteger(milliseconds) && milliseconds > 0);
        const fromMessage = messages.length;
        child.send({ type: "test:advance-attachment-clock", milliseconds });
        const advanced = await harness.waitUntil(() =>
          messages
            .slice(fromMessage)
            .find((message) => message.type === "test:attachment-clock-advanced"),
        );
        assert.equal(advanced.type, "test:attachment-clock-advanced");
        if (advanced.type !== "test:attachment-clock-advanced") assert.fail("clock ACK required");
        assert.equal(advanced.before, now);
        assert.equal(advanced.now, now + milliseconds);
        now = advanced.now;
      },
    };
  } catch (error) {
    if (h) await h.close();
    else await fixture.close();
    throw error;
  }
}
