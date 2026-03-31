export interface SharedProject {
  agentPath: string;
  sourcePath: string;
  hostPath: string;
  guestPath: string;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  defaultBaseBranch: string | null;
  repoPath: string | null;
  metadataFile: string | null;
  toolingFile: string | null;
  notesFile: string | null;
  active: boolean;
}

export interface RepoManifest {
  id: string | null;
  displayName: string | null;
  tags: string[];
  defaultWorktreePrefix: string | null;
  docs: string[];
  preferredEntrypoint: string | null;
}

export type SessionState = "missing" | "idle" | "running" | "unknown";

export interface SessionRecord {
  sessionName: string;
  transport: "tmux";
  cwd: string | null;
  state: SessionState;
  lastSeenAt: string | null;
  projectId: string | null;
  worktree: string | null;
}

export type ProjectVisibility = "metadata-only" | "shared-only" | "metadata-and-shared";

export interface HubProjectRecord {
  key: string;
  projectId: string | null;
  displayName: string;
  share: SharedProject | null;
  projectMetadata: ProjectMetadata | null;
  manifest: RepoManifest | null;
  session: SessionRecord | null;
  actionable: boolean;
  visibility: ProjectVisibility;
}

export interface HubSnapshot {
  generatedAt: string;
  shares: SharedProject[];
  projectMetadata: ProjectMetadata[];
  sessions: SessionRecord[];
  projects: HubProjectRecord[];
}
