import { appendFileSync, readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
  let sequence = 0;
  pi.on("message_end", (event, ctx) => {
    if (!process.env.BRIDGE_PROBE_PERSISTENCE_LOG) return;
    const entries = readFileSync(ctx.sessionManager.getSessionFile(), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const persisted = entries.some(entry => entry.message?.role === event.message.role && entry.message?.timestamp === event.message.timestamp);
    appendFileSync(process.env.BRIDGE_PROBE_PERSISTENCE_LOG, JSON.stringify({ role: event.message.role, persisted }) + "\n");
  });
  pi.registerProvider("bridge-probe", {
    baseUrl: "https://bridge-probe.invalid", apiKey: "test-key", api: "bridge-probe-api",
    models: [{ id: "fake", name: "Bridge Probe", reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
      { id: "fake-text", name: "Bridge Text Probe", reasoning: true, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.filter(message => message.role === "user").at(-1);
      const slow = JSON.stringify(last?.content).includes("hold for abort");
      const question = JSON.stringify(last?.content).includes("ask choice");
      let timer;
      const abort = () => emit(true);
      const emit = (aborted = false) => {
        clearTimeout(timer); options?.signal?.removeEventListener("abort", abort);
        const message = { role: "assistant", content: question ? [{ type: "toolCall", id: `question-${++sequence}`, name: "remote_checkpoint", arguments: { kind: "question", decision: "Choose one", options: ["First", "Second"] } }] : [{ type: "text", text: "probe answer" }], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: question ? "toolUse" : "stop", timestamp: Date.now() + ++sequence };
        if (aborted) stream.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted" } });
        else {
          stream.push({ type: "start", partial: { ...message, content: [] } });
          stream.push({ type: "done", reason: question ? "toolUse" : "stop", message });
        }
        stream.end();
      };
      if (slow) { timer = setTimeout(emit, 10000); options?.signal?.addEventListener("abort", abort, { once: true }); }
      else queueMicrotask(emit);
      return stream;
    },
  });
  pi.registerCommand("probe-submit", { handler: async () => {
    pi.sendUserMessage("/probe-template raw", { expandPromptTemplates: true,
      onPromptExpanded: text => `Attributed remote input:\n${text}`,
      preflightResult: success => appendFileSync(process.env.BRIDGE_PROBE_RECEIPTS, `${success}\n`),
    });
  } });
}
