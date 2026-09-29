import { createHash } from "node:crypto";
import { ManagedMatrixClient } from "./matrix-client.js";
import { RelayRegistry, RelayRegistryError } from "./registry.js";

/** Project identity is portable; a private Matrix Space belongs to one host. */
export function projectSpaceAlias(hostId: string, projectKey: string): string {
	const hash = createHash("sha256").update("pi-managed-sessions:project-space:v2\0");
	for (const part of [hostId, projectKey]) hash.update(`${Buffer.byteLength(part)}:`).update(part);
	return `pi-project-v2-${hash.digest("hex").slice(0, 32)}-space`;
}

/** All callers share lookup, legacy recovery, and authority rules. No state is migrated on startup. */
export class ProjectSpaces {
	constructor(private readonly registry: RelayRegistry, private readonly matrix: ManagedMatrixClient) {}

	private bound(projectKey: string): string | undefined {
		const spaces = new Set(this.registry.listManifests()
			.filter((item) => item.kind === "project" && item.projectKey === projectKey)
			.map((item) => item.projectSpace).filter((item): item is string => Boolean(item)));
		if (spaces.size > 1) throw new RelayRegistryError("invalid_state", "Stable project identity maps to conflicting Matrix Spaces");
		return [...spaces][0];
	}

	async find(projectKey: string): Promise<string | undefined> {
		const bound = this.bound(projectKey);
		if (bound) {
			await this.matrix.assertRoomAuthority(bound, true, undefined, { spaceChild: true });
			return bound; // Preserve working legacy bindings, even if their alias has changed.
		}
		return this.matrix.resolvePrivateRoomAlias(projectSpaceAlias(this.registry.hostId, projectKey), true);
	}

	async ensure(projectKey: string, name: string, recoverLegacy = false): Promise<string> {
		const bound = this.bound(projectKey);
		if (bound) {
			await this.matrix.assertRoomAuthority(bound, true, undefined, { spaceChild: true });
			return bound;
		}
		// Only a durable interrupted operation may probe the old global alias. Never
		// create through it: it may belong to another host using the same workspace.
		if (recoverLegacy) {
			const current = await this.find(projectKey);
			if (current) return current;
			const legacy = await this.matrix.resolveLegacyProjectSpace(projectKey);
			if (legacy) return legacy;
		}
		return this.matrix.createPrivateSpaceIdempotent(name, projectSpaceAlias(this.registry.hostId, projectKey));
	}

	async assertTarget(projectKey: string, spaceId: string): Promise<void> {
		const bound = this.bound(projectKey);
		if (bound && bound !== spaceId) throw new RelayRegistryError("invalid_state", "Project Space conflicts with its durable binding");
		if (!bound) {
			const current = await this.matrix.resolvePrivateRoomAlias(projectSpaceAlias(this.registry.hostId, projectKey), true);
			if (current !== spaceId) {
				// A checkpointed pre-upgrade target is authoritative: unlike an unbound
				// legacy probe, any permission/identity failure here must stop recovery.
				const legacy = await this.matrix.resolvePrivateRoomAlias(`pi-${projectKey.slice("project_".length)}-space`, true);
				if (legacy !== spaceId) throw new RelayRegistryError("invalid_state", "Project Space no longer matches its deterministic alias");
			}
		}
		await this.matrix.assertRoomAuthority(spaceId, true, undefined, { spaceChild: true });
	}
}
