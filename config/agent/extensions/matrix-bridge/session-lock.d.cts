declare const lock: {
  acquireSessionLock(file: string): () => void;
  canonical(file: string): string;
  lockPath(file: string): string;
};
export = lock;
