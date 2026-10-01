import { createHash } from "node:crypto";
import {
	HOST_CONTROL_VERSION, isHostReadAction, parseHostRequest, parseHostResponse,
	type HostActor, type HostReadAction, type HostResponse,
} from "../live-workspace-contracts.js";
import { HostPolicy } from "./host-policy.js";
import type { ModelHostRequest } from "./host-approval-record.js";
import { HostControlError, hostErrorResponse } from "./host-control-error.js";

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

function requestId(value: unknown): string {
	if (value && typeof value === "object" && "actor" in value && value.actor && typeof value.actor === "object" &&
		"requestId" in value.actor && typeof value.actor.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.actor.requestId)) return value.actor.requestId;
	return "invalid-request";
}

export interface HostReadRequest { version: typeof HOST_CONTROL_VERSION; actor: HostActor; action: HostReadAction }

/** One validated/policy-governed seam; frontend authentication is mandatory and separate. */
export class HostDispatcher {
	private readonly requests = new Map<string, { digest: string; expiresAt: number; response: Promise<HostResponse> }>();
	private readonly now: () => number;
	private readonly capacity: number;
	constructor(private readonly options: {
		hostId: string; protectedConversationId: string; policy: HostPolicy;
		read: (request: HostReadRequest) => Promise<unknown>;
		approve?: (request: ModelHostRequest) => Promise<HostResponse>;
		now?: () => number; requestCapacity?: number;
	}) {
		this.options = { ...options };
		this.now = options.now ?? (() => performance.now()); this.capacity = options.requestCapacity ?? 1_024;
		if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 4_096) throw Error("Invalid host request capacity");
	}

	async dispatch(input: unknown, authenticatedActor: HostActor): Promise<HostResponse> {
		let id = "invalid-request";
		try {
			id = requestId(input);
			if (input && typeof input === "object" && "version" in input && typeof input.version === "string" && input.version !== HOST_CONTROL_VERSION)
				throw new HostControlError("upgrade_required", "Unsupported host control version");
			let request;
			try {
				// Normalize JSON optionals and detach the caller's mutable objects before any await.
				request = JSON.parse(JSON.stringify(parseHostRequest(input))) as ReturnType<typeof parseHostRequest>;
				parseHostRequest({ ...request, actor: authenticatedActor });
			} catch { throw new HostControlError("invalid_request", "Invalid host control request"); }
			if (canonical(request.actor) !== canonical(authenticatedActor)) throw new HostControlError("forbidden", "Requester does not match the authenticated frontend");
			// Mutations never use the volatile read-replay cache or an automatic execution retry.
			if (request.actor.kind === "model" && !isHostReadAction(request.action) && this.options.approve &&
				this.options.policy.decide(request, this.options.protectedConversationId) === "approval") {
				const response = parseHostResponse(request.action.operation, await this.options.approve(request as ModelHostRequest));
				if (response.requestId !== id) throw new HostControlError("failed", "Approval response correlation is invalid");
				return response;
			}
			const now = this.now();
			for (const [key, value] of this.requests) if (value.expiresAt <= now) this.requests.delete(key);
			const digest = createHash("sha256").update(canonical([this.options.hostId, request])).digest("hex");
			const retained = this.requests.get(id);
			if (retained && retained.digest !== digest) throw new HostControlError("conflict", "Retained request identity has different arguments or requester context");
			if (retained) return structuredClone(await retained.response);
			if (this.requests.size >= this.capacity) throw new HostControlError("unavailable", "Host request capacity reached; retry later", true);
			// Publish the shared promise before execution; never expire in-flight work.
			const entry = { digest, expiresAt: Infinity, response: Promise.resolve().then(() => this.execute(request)) };
			entry.response = entry.response.then((response) => { entry.expiresAt = this.now() + 60_000; return response; });
			this.requests.set(id, entry);
			return structuredClone(await entry.response);
		} catch (error) { return hostErrorResponse(id, error); }
	}

	private async execute(request: ReturnType<typeof parseHostRequest>): Promise<HostResponse> {
		const id = request.actor.requestId;
		try {
			const decision = this.options.policy.decide(request, this.options.protectedConversationId);
			if (decision === "forbidden") throw new HostControlError("forbidden", "Host action is forbidden");
			if (decision === "approval") throw new HostControlError("approval_required", "This action requires its own host approval");
			// Mutation execution joins through the durable approval/retirement/open owners.
			// This volatile read-replay cache must never substitute for their execution journal.
			if (!isHostReadAction(request.action)) throw new HostControlError("upgrade_required", "This relay does not yet support this mutation through host controls");
			const data = await this.options.read({ version: request.version, actor: request.actor, action: request.action });
			return structuredClone(parseHostResponse(request.action.operation, { version: HOST_CONTROL_VERSION, requestId: id, ok: true, data }));
		} catch (error) { return hostErrorResponse(id, error); }
	}
}
