import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export default function registerGuiConfirmE2e(pi) {
  pi.registerCommand("gui-confirm-e2e", {
    description: "Exercise the desktop confirmation dialog",
    handler: async (args, ctx) => {
      const suffix = args.trim();
      if (suffix !== "accept" && suffix !== "decline") return;
      const confirmed = await ctx.ui.confirm("GUI_CONFIRM_E2E", `Confirm ${suffix}?`);
      await writeFile(
        join(ctx.cwd, `gui-confirm-${suffix}.txt`),
        confirmed ? "accepted" : "declined",
      );
    },
  });
}
