import { MatrixError } from "../matrix-shared/http.js";
import { CONTROL_HELP, nativeControl, pollVote, POLL_RESPONSE, type Interaction } from "./interaction.js";
import { CAPTIONLESS_IMAGE_PROMPT, imageInfo } from "./media.js";
import type { BridgeMatrix } from "./matrix.js";
import type { Binding, BridgeStore, Input, Prompt } from "./store.js";
import { object } from "./wire.js";

/** Room-scoped authorization; parsing alone never grants execution authority. */
export async function authorizeInput(store: BridgeStore, matrix: BridgeMatrix, binding: Binding, input: Input, signal?: AbortSignal,
  approval?: (interaction: Interaction, accepted: boolean) => Promise<void>): Promise<void> {
  const ignore = () => { store.authorize(input.id, undefined); };
  const explain = (message: string) => store.finishInput(binding.key, input.id, message);
  const event = input.event, sender = typeof event.sender === "string" ? event.sender : "";
  if (!binding.enabled || binding.archived || !binding.room || !/^@[^:\s]+:[^\s]+$/.test(sender) || matrix.ignoredSender(sender)) return ignore();
  let content: Record<string, unknown>, relation: Record<string, unknown>;
  try { content = object(event.content ?? {}); relation = object(content["m.relates_to"] ?? {}); } catch { return ignore(); }
  if (relation.rel_type === "m.replace" || Object.hasOwn(content, "m.new_content")) return ignore();
  const voting = event.type === POLL_RESPONSE || event.type === "m.poll.response", vote = pollVote(event.type, content);
  if (voting && !vote || !voting && !["m.room.message", "m.room.encrypted"].includes(String(event.type))) return ignore();
  if (!await matrix.joined(binding.room, sender)) return ignore();
  if (event.type === "m.room.encrypted") return explain("Encrypted input is not supported by this bridge. Send unencrypted text or a supported image.");
  let interaction: Interaction | undefined;
  if (vote) {
    interaction = store.interactionByEvent(binding.key, vote.eventId);
    if (!interaction) {
      // A client may vote after server acceptance but before the start ACK was
      // durably recorded. Let the original PUT recover its receipt first.
      const active = store.activeInteraction(binding.key);
      if (active?.options && !store.outputs(binding.key, `interaction:${active.id}`)[0]?.eventId) return;
      return ignore();
    }
    if (interaction.state !== "active" || !interaction.options?.[vote.index]) return ignore();
    if (interaction.kind === "approval") { if (approval) await approval(interaction, vote.index === 0); else ignore(); return; }
    const answer = interaction.options[vote.index]!;
    store.authorize(input.id, interaction.kind === "question" ? { text: `Answer to the recorded question: ${answer}`, sender, question: interaction.nativeEntry } :
      { text: answer, sender, control: interaction.kind, argument: answer }, { interaction: interaction.id });
    return;
  }
  if (content.msgtype !== "m.text" && content.msgtype !== "m.image") {
    if (["m.file", "m.audio", "m.video"].includes(String(content.msgtype))) return explain("Only text and original JPEG/PNG/WebP images are supported. No caption-only prompt was submitted.");
    return ignore();
  }
  if (content.msgtype === "m.text" && (typeof content.body !== "string" || !content.body.trim())) return ignore();
  if (content.msgtype === "m.text" && Object.keys(relation).some(key => key !== "m.in_reply_to")) return ignore();
  let reply: string | undefined;
  try { if (relation["m.in_reply_to"]) { const target = object(relation["m.in_reply_to"]); if (typeof target.event_id !== "string" || Object.keys(target).length !== 1) return ignore(); reply = target.event_id; } }
  catch { return ignore(); }
  const referenced = reply ? store.interactionByEvent(binding.key, reply) : undefined;
  if (referenced && referenced.state !== "active") return ignore();
  let text = typeof content.body === "string" ? content.body : "";
  if (reply && text.startsWith("> ") && text.includes("\n\n")) text = text.slice(text.indexOf("\n\n") + 2);
  if (referenced?.kind === "approval") {
    const answer = text.trim().toLowerCase();
    if (content.msgtype !== "m.text" || !["approve", "cancel"].includes(answer)) return explain("The configured operator must use the approval poll or reply directly with Approve or Cancel. Ordinary conversation is not approval.");
    if (approval) await approval(referenced, answer === "approve"); else ignore(); return;
  }
  if (content.msgtype === "m.text") {
    const control = nativeControl(text);
    if (control === "unknown") return explain(`Unknown native control. ${CONTROL_HELP}`);
    if (control?.name === "help") return explain(CONTROL_HELP);
    if (control) { store.authorize(input.id, { text, sender, control: control.name, argument: control.argument }); return; }
  }
  interaction = referenced;
  interaction ??= input.interaction ? store.interaction(input.interaction) : undefined;
  // Unrelated text is a fresh instruction, never implicit mutation approval.
  if (interaction?.kind === "approval") interaction = undefined;
  if (interaction && interaction.state !== "active") return ignore();
  if (interaction && !reply) {
    const published = store.interactionPosition(interaction);
    if (published === undefined) return; // Await own start in the authoritative room timeline, not a cross-host clock guess.
    if (input.position <= published) return explain("This input preceded the displayed question. Send a fresh answer or reply directly to that question.");
  }
  if (!interaction && input.position <= (store.progress<number>(`question-cutoff:${binding.key}`) ?? -1)) return explain("This input was pending at a question boundary. It was not submitted; send a fresh instruction to continue.");
  if (interaction && (interaction.kind === "model" || interaction.kind === "thinking")) {
    const number = /^(?:[1-9]|1[0-9]|20)$/.test(text.trim()) ? Number(text.trim()) - 1 : -1;
    const answer = interaction.options?.includes(text.trim()) ? text.trim() : interaction.options?.[number];
    if (!answer || content.msgtype !== "m.text") return explain("Reply with one of the displayed choices, its number, or use an explicit !model/!thinking command.");
    store.authorize(input.id, { text: answer, sender, control: interaction.kind, argument: answer }, { interaction: interaction.id }); return;
  }
  if (content.msgtype === "m.image") {
    if (Object.hasOwn(content, "file") || Object.hasOwn(content, "m.relates_to") || typeof content.url !== "string" || content.body !== undefined && typeof content.body !== "string") return explain("Encrypted, related or malformed images are unsupported. Resend an original JPEG/PNG/WebP; the caption was not submitted alone.");
    try {
      const bytes = await matrix.http.downloadMedia(content.url, signal), image = imageInfo(bytes);
      const caption = typeof content.filename !== "string" || text !== content.filename ? text.trim() : "";
      store.authorize(input.id, { text: caption || CAPTIONLESS_IMAGE_PROMPT, sender, image, question: interaction?.nativeEntry }, { interaction: interaction?.id, image: bytes });
    } catch (error) {
      if (error instanceof MatrixError && (error.retryable || error.code === "cancelled")) throw error;
      explain("The image is unavailable or is not a supported original JPEG/PNG/WebP. No caption-only request or model switch was made.");
    }
    return;
  }
  const followUp = text.startsWith("!follow-up "), steer = text.startsWith("!steer ");
  const prompt: Prompt = { text: followUp ? text.slice(11) : steer ? text.slice(7) : text, sender, deliverAs: followUp ? "followUp" : "steer", question: interaction?.nativeEntry };
  store.authorize(input.id, prompt, { interaction: interaction?.id });
}
