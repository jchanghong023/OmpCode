import type { OmpBtwFrame } from "../domain/OmpBtwFrames.js";

/** 父进程的 BTW 事件 fan-out；不拥有运行、队列或历史。 */
export class OmpBtwEventBridge {
  private readonly listeners = new Set<(frame: OmpBtwFrame | null) => void>();

  readonly subscribe = (listener: (frame: OmpBtwFrame | null) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly emit = (frame: OmpBtwFrame | null): void => {
    for (const listener of this.listeners) listener(frame);
  };

  dispose(): void {
    this.emit(null);
    this.listeners.clear();
  }
}
