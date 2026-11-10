import { object, string } from "./wire.js";

export type NativeControl = "help" | "status" | "start" | "stop" | "abort" | "model" | "thinking" | "compact";
export type InteractionSpec = { kind: "question" | "model" | "thinking"; question: string; options?: string[]; nativeEntry?: string };
export type Interaction = InteractionSpec & { id: string; binding: string; source: string; state: "active" | "answered" | "cancelled"; answer?: string };
export const POLL_START = "org.matrix.msc3381.poll.start", POLL_RESPONSE = "org.matrix.msc3381.poll.response", POLL_END = "org.matrix.msc3381.poll.end";

export function interactionSpec(value: unknown): InteractionSpec {
  const input = object(value), kind = input.kind;
  if (kind !== "question" && kind !== "model" && kind !== "thinking") throw Error("Invalid interaction kind");
  const question = string(input.question, 8000);
  let options: string[] | undefined;
  if (input.options !== undefined) {
    if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > 20) throw Error("Invalid interaction choices");
    options = input.options.map(option => string(option, 1024));
    if (new Set(options).size !== options.length) throw Error("Duplicate interaction choices");
  }
  const spec: InteractionSpec = { kind, question, ...(options ? { options } : {}), ...(input.nativeEntry !== undefined ? { nativeEntry: string(input.nativeEntry, 128) } : {}) };
  if (Buffer.byteLength(JSON.stringify(pollStart(spec)), "utf8") > 60000) throw Error("Interaction exceeds one Matrix event; narrow the choices");
  return spec;
}
export function pollStart(spec: InteractionSpec): { type: string; content: Record<string, unknown> } {
  if (!spec.options) return { type: "m.room.message", content: { msgtype: "m.notice", body: spec.question, "m.mentions": {} } };
  return { type: POLL_START, content: {
    "m.mentions": {}, "org.matrix.msc1767.text": [spec.question, ...spec.options.map((option, index) => `${index + 1}. ${option}`), "Reply with text if polls are unavailable."].join("\n"),
    [POLL_START]: { kind: "org.matrix.msc3381.poll.disclosed", max_selections: 1, question: { "org.matrix.msc1767.text": spec.question },
      answers: spec.options.map((option, index) => ({ id: `answer-${index}`, "org.matrix.msc1767.text": option })) },
  } };
}
export function pollEnd(eventId: string): { type: string; content: Record<string, unknown> } {
  return { type: POLL_END, content: { "m.relates_to": { rel_type: "m.reference", event_id: eventId }, "org.matrix.msc1767.text": "This question is closed. Send a fresh instruction to continue.", [POLL_END]: {}, "m.mentions": {} } };
}
export function pollVote(type: unknown, value: unknown): { eventId: string; index: number } | undefined {
  if (type !== POLL_RESPONSE && type !== "m.poll.response") return;
  try {
    const content = object(value), relation = object(content["m.relates_to"]);
    if (relation.rel_type !== "m.reference" || Object.keys(relation).length !== 2 || Object.keys(content).length !== 2) return;
    const answers = type === POLL_RESPONSE ? object(content[POLL_RESPONSE]).answers : content["m.selections"];
    if (type === POLL_RESPONSE && Object.keys(object(content[POLL_RESPONSE])).length !== 1 || !Array.isArray(answers) || answers.length !== 1 || typeof answers[0] !== "string" || !/^answer-(?:[0-9]|1[0-9])$/.test(answers[0])) return;
    return { eventId: string(relation.event_id, 255), index: Number(answers[0].slice(7)) };
  } catch { return; }
}
export function nativeControl(text: string): { name: NativeControl; argument?: string } | "unknown" | undefined {
  const match = /^!([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim()); if (!match) return;
  if (match[1] === "follow-up" || match[1] === "steer") return;
  if (!["help", "status", "start", "stop", "abort", "model", "thinking", "compact"].includes(match[1]!)) return "unknown";
  const argument = match[2]?.trim();
  if (argument && !["model", "thinking", "compact"].includes(match[1]!)) return "unknown";
  return { name: match[1] as NativeControl, ...(argument ? { argument } : {}) };
}
export const CONTROL_HELP = "Native Pi controls: !help, !status, !start (open idle, no model turn), !stop, !abort, !model [provider/model or filter], !thinking [level], !compact [focus], !follow-up TEXT, !steer TEXT. Local Pi remains available without Matrix.";
