/** A generation fence prevents durable enqueue/ack wakes being lost before sleep. */
export class DeliveryWake {
 private generation = 0;
 private readonly listeners = new Set<() => void>();
 version(): number { return this.generation; }
 notify(): void { this.generation++; for (const listener of [...this.listeners]) listener(); }
 wait(version: number, milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || version !== this.generation || milliseconds <= 0) return Promise.resolve();
  return new Promise(resolve => {
   const done = () => { clearTimeout(timer); this.listeners.delete(done); signal.removeEventListener("abort", done); resolve(); };
   const timer = setTimeout(done, milliseconds);
   this.listeners.add(done); signal.addEventListener("abort", done, { once: true });
   if (signal.aborted || version !== this.generation) done();
  });
 }
}
