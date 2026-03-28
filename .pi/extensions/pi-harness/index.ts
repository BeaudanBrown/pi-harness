import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("harness-status", {
    description: "Show whether the harness extension is loaded",
    handler: async (_args, ctx) => {
      await ctx.ui.notify("pi-harness extension loaded", "info");
    },
  });
}
