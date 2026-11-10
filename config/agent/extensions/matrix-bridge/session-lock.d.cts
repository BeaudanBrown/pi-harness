declare const lock: {
  acquireSessionLock(file: string): () => void;
  canonical(file: string): string;
  tryTaskLock(common: string, purpose: "setup" | "git"): { fd: number; release(): void } | undefined;
  lockPath(file: string): string;
  renameNoReplace(source: string, target: string): void;
};
export = lock;
