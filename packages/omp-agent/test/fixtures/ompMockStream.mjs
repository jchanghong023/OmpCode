/**
 * Derived from oh-my-pi packages/ai/src/utils/event-stream.ts at
 * 57672f546162e16b019484626c3b5fa9300aafef, MIT (see third-party/upstream/omp-mock.LICENSE).
 * Modified by ZCode: erase TypeScript; use native Error instead of pi-ai error
 * classification. Preserve queue, terminal/result and local-work semantics.
 */
const QUEUE_COMPACT_MIN_HEAD = 64;

export class EventStream {
  queue = [];
  #queueHead = 0;
  waiting = [];
  done = false;
  resultSettled = false;
  #failed = false;
  #error;
  #pendingLocalWork = 0;
  #localWorkSettledAt = 0;
  #localWorkDelegate;

  constructor(isComplete, extractResult) {
    const { promise, resolve, reject } = Promise.withResolvers();
    // A failed producer must not cause background unhandled rejections when
    // the consumer iterates events without also awaiting result().
    promise.catch(() => {});
    this.finalResultPromise = promise;
    this.resolveFinalResult = resolve;
    this.rejectFinalResult = reject;
    this.isComplete = isComplete;
    this.extractResult = extractResult;
  }

  push(event) {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resultSettled = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    this.deliver(event);
  }

  deliver(event) {
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result) {
    this.done = true;
    if (result !== undefined) {
      this.resultSettled = true;
      this.resolveFinalResult(result);
    } else if (!this.resultSettled) {
      this.resultSettled = true;
      this.rejectFinalResult(new Error("Stream ended without a final result"));
    }
    this.endWaiting();
  }

  endWaiting() {
    while (this.waiting.length > 0) this.waiting.shift().resolve({ value: undefined, done: true });
  }

  fail(error) {
    if (this.done) return;
    this.done = true;
    this.#failed = true;
    this.#error = error;
    this.resultSettled = true;
    this.rejectFinalResult(error);
    while (this.waiting.length > 0) this.waiting.shift().reject(error);
  }

  #dequeue() {
    const queue = this.queue;
    const head = this.#queueHead;
    const event = queue[head];
    if (head + 1 === queue.length) {
      queue.length = 0;
      this.#queueHead = 0;
      return event;
    }
    queue[head] = undefined;
    this.#queueHead = head + 1;
    if (this.#queueHead >= QUEUE_COMPACT_MIN_HEAD && this.#queueHead * 2 >= queue.length) {
      queue.splice(0, this.#queueHead);
      this.#queueHead = 0;
    }
    return event;
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.#queueHead < this.queue.length) yield this.#dequeue();
      else if (this.#failed) throw this.#error;
      else if (this.done) return;
      else {
        const result = await new Promise((resolve, reject) =>
          this.waiting.push({ resolve, reject }),
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result() {
    return this.finalResultPromise;
  }
  get hasPendingLocalWork() {
    return this.#pendingLocalWork > 0 || (this.#localWorkDelegate?.hasPendingLocalWork ?? false);
  }
  get localWorkSettledAt() {
    return Math.max(this.#localWorkSettledAt, this.#localWorkDelegate?.localWorkSettledAt ?? 0);
  }
  forwardLocalWorkFrom(source) {
    this.#localWorkDelegate = source;
  }
  async trackLocalWork(work) {
    this.#pendingLocalWork++;
    try {
      return await work;
    } finally {
      this.#pendingLocalWork--;
      if (this.#pendingLocalWork === 0) this.#localWorkSettledAt = Date.now();
    }
  }
}

export class AssistantMessageEventStream extends EventStream {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type for final result");
      },
    );
  }
}

export function createAssistantMessageEventStream() {
  return new AssistantMessageEventStream();
}
