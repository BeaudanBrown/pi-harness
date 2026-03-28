export default function (pi: { registerCommand: (name: string, options: { description: string; handler: (args: unknown, ctx: { ui: { notify: (msg: string, level?: string) => Promise<void> } }) => Promise<void> }) => void }) {
  pi.registerCommand("harness-status", {
    description: "Show whether the harness extension is loaded",
    handler: async (_args, ctx) => {
      await ctx.ui.notify("pi-harness extension loaded", "info");
    },
  });
}
