import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { MatrixRoomIdSchema } from "../matrix-shared/room-id.js";

export const MANAGED_PROVENANCE_EVENT = "lol.bepis.pi.managed.v1";
const identifier = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
const room = MatrixRoomIdSchema;
const stable = (prefix: string) => Type.String({ pattern: `^${prefix}_[a-f0-9]{32}$` });
const common = { version: Type.Literal(1), hostId: identifier, creationKey: identifier };
const project = { projectKey: stable("project"), parentRoomId: room };
export const ManagedProvenanceSchema = Type.Union([
	Type.Object({ ...common, kind: Type.Literal("host_space") }, { additionalProperties: false }),
	Type.Object({ ...common, kind: Type.Literal("project_space"), ...project }, { additionalProperties: false }),
	Type.Object({ ...common, kind: Type.Literal("worktree_space"), ...project, checkoutId: stable("checkout") }, { additionalProperties: false }),
	Type.Object({ ...common, kind: Type.Literal("conversation"), ...project, checkoutId: stable("checkout"), conversationId: stable("conv") }, { additionalProperties: false }),
	Type.Object({ ...common, kind: Type.Literal("coordinator"), parentRoomId: room, conversationId: stable("conv") }, { additionalProperties: false }),
]);
export type ManagedProvenance = Static<typeof ManagedProvenanceSchema>;
export function parseManagedProvenance(value: unknown): ManagedProvenance {
	if (!Check(ManagedProvenanceSchema, value)) throw new Error("Invalid managed room provenance");
	return value;
}
function digest(domain: string, parts: string[]): string {
	const hash = createHash("sha256").update(`pi-managed-sessions:${domain}:live-v1\0`);
	for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`).update(part);
	return hash.digest("hex").slice(0, 32);
}
/** The root is supplied by the host's canonical workspace resolver, never by model text. */
export function deriveCheckoutId(hostId: string, projectKey: string, canonicalRoot: string): string {
	if (!Check(identifier, hostId) || !/^project_[a-f0-9]{32}$/.test(projectKey) || !isAbsolute(canonicalRoot) ||
		normalize(canonicalRoot) !== canonicalRoot || canonicalRoot.length > 4096 ||
		(canonicalRoot !== "/" && canonicalRoot.endsWith("/")) || /[\u0000-\u001f\u007f]/.test(canonicalRoot)) throw new Error("Invalid canonical checkout identity");
	return `checkout_${digest("checkout", [hostId, projectKey, canonicalRoot])}`;
}
/** Parent IDs and mutable names deliberately do not participate in object identity. */
export function managedRoomAlias(provenance: ManagedProvenance): string {
	const value = parseManagedProvenance(provenance);
	return `pi-live-v1-${digest("room-alias", [value.hostId, value.kind, value.creationKey,
		"projectKey" in value ? value.projectKey : "", "checkoutId" in value ? value.checkoutId : "",
		"conversationId" in value ? value.conversationId : ""])}`;
}
export function safeManagedTitle(title: string, identity: string, fallback: "conversation" | "project" | "worktree" | "host" | "coordinator" = "conversation", occupied: ReadonlySet<string> = new Set()): string {
	if (!Check(identifier, identity)) throw new Error("Invalid title fallback identity");
	const cleaned = title.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "").replace(/\s+/gu, " ").trim();
	if (cleaned) return Array.from(cleaned).slice(0, 80).join("");
	const suffix = /_([a-f0-9]{32})$/.exec(identity)?.[1] ?? digest("title", [identity]);
	for (let length = 8; length <= suffix.length; length += 4) {
		const candidate = `${fallback}-${suffix.slice(0, length)}`;
		if (!occupied.has(candidate)) return candidate;
	}
	// A named conversation may deliberately use even the complete fallback ID.
	for (let ordinal = 1; ordinal <= occupied.size + 1; ordinal++) {
		const candidate = `${fallback}-${suffix}-${ordinal}`;
		if (!occupied.has(candidate)) return candidate;
	}
	throw Error("Could not allocate a unique fallback title");
}
