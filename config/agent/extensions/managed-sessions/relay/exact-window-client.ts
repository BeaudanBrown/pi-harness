import { parseExactWindowProof, type ExactWindowProof } from "../exact-window-contracts.js";
import { Check } from "typebox/value";
import { ConversationIdSchema, WorkspaceIdentitySchema } from "../identity-contracts.js";
import type { WorkspaceIdentity } from "../contracts.js";

/** No fallback to reusable tmux IDs or bridge-clear. The launcher owns the atomic guard. */
export class ExactWindowClient {
	constructor(private readonly invoke: (operation: string, request: object) => Promise<Record<string, unknown>>) {}
	async create(conversationId: string, launchId: string, placement: WorkspaceIdentity): Promise<ExactWindowProof> {
		if (!Check(ConversationIdSchema, conversationId) || !/^launch_[a-f0-9]{32}$/.test(launchId) || !Check(WorkspaceIdentitySchema, placement)) throw Error("Exact window creation identity is invalid");
		const frozen = structuredClone(placement);
		const result = await this.invoke("window-create-exact", { conversationId, launchId, placement: structuredClone(frozen) });
		const fields = ["conversationId", "sessionName", "windowId", "paneId", "role", "rootKey", "workspace", "relativeCwd", "ownership"];
		if (Object.keys(result).length !== fields.length || Object.keys(result).some((key) => !fields.includes(key))) throw Error("Exact window creation result is invalid");
		const proof = parseExactWindowProof(result.ownership);
		if (proof.conversationId !== conversationId || proof.launchId !== launchId || result.conversationId !== conversationId || result.role !== "conversation" ||
			result.sessionName !== proof.sessionName || result.windowId !== proof.windowId || result.paneId !== proof.paneId ||
			result.rootKey !== frozen.rootKey || result.workspace !== frozen.workspace || result.relativeCwd !== frozen.relativeCwd) throw Error("Exact window creation changed its reserved identity");
		return proof;
	}
	async inspect(conversationId: string): Promise<ExactWindowProof | undefined> {
		const result = await this.invoke("window-inspect-exact", { conversationId });
		if (result.conversationId !== conversationId || typeof result.exists !== "boolean" ||
			Object.keys(result).some((key) => !["conversationId", "exists", ...(result.exists ? ["ownership"] : [])].includes(key))) throw Error("Exact window observation is invalid");
		if (!result.exists) return undefined;
		const proof = parseExactWindowProof(result.ownership);
		if (proof.conversationId !== conversationId) throw Error("Exact window observation changed conversation");
		return proof;
	}
	async check(value: ExactWindowProof): Promise<"match" | "gone" | "changed"> {
		const result = await this.invoke("window-check-exact", parseExactWindowProof(value));
		if (Object.keys(result).length !== 1 || typeof result.state !== "string" || !["match", "gone", "changed"].includes(result.state)) throw Error("Exact window state is unknown");
		return result.state as "match" | "gone" | "changed";
	}
	async terminate(value: ExactWindowProof): Promise<boolean> {
		const proof = parseExactWindowProof(value);
		const result = await this.invoke("window-terminate-exact", proof);
		if (Object.keys(result).length !== 1 || typeof result.terminated !== "boolean") throw Error("Exact window termination outcome is unknown");
		return result.terminated;
	}
}
