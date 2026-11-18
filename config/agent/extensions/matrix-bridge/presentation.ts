import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Best-effort local focus hints, not writer locks or execution authority. */
export function installPresentation(pi: ExtensionAPI): void {
  const pane = process.env.TMUX_PANE;
  if (!pane || !/^%[0-9]+$/.test(pane) || !process.env.TMUX) return;
  const tmux = process.env.PI_HARNESS_TMUX || "tmux";
  let work = Promise.resolve();
  const update = (ctx?: ExtensionContext) => {
    work = work.then(async () => {
      let hint = "";
      if (ctx) {
        const file = ctx.sessionManager.getSessionFile();
        if (file) {
          try {
            const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
            const birth = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
            hint = JSON.stringify({ file, nativeId: ctx.sessionManager.getSessionId(), pid: process.pid, birth });
          } catch { return; }
        }
      }
      await pi.exec(tmux, ["set-option", "-p", "-t", pane, "@pi_native_session", hint], { timeout: 1000 });
      await pi.exec(tmux, ["set-option", "-pu", "-t", pane, "@pi_native_launch"], { timeout: 1000 });
    }).catch(() => {});
  };
  pi.on("session_start", (_event, ctx) => { update(ctx); });
  pi.on("session_shutdown", () => { update(); });
}
