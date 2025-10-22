import { Disposable, Event, Emitter, MessageReader, MessageWriter, DataCallback, PartialMessageInfo, Message } from "vscode-jsonrpc";

type BrokerMessage =
  | { type: "worker-message"; message: Message }
  | { type: "worker-request"; id: string; message: Message }
  | { type: "worker-response"; id: string; message: Message };

export class MultiTabWorkerBrokerError extends Error {
  constructor(message: string, readonly) {
    super(message);
    this.name = "MultiTabWorkerBrokerError";
  }
}

/**
 * A worker broker that allows multiple tabs open on the same origin to all talk to one active tab's worker
 * Supports tabs coming and going and re-electing the active tab as leader
 */
export class MultiTabWorkerBroker {
  isLeader = false;
  reader = new MultiTabMessageReader();
  writer = new MultiTabMessageWriter();

  private broadcastChannel: BroadcastChannel | null = null;
  private worker: Worker | null = null;
  private lockAbortController: AbortController | null = null;
  private pendingRequests = new Map<string, { resolve: (message: Message) => void; reject: (error: Error) => void }>();
  private nextRequestId = 0;
  private started = false;
  private timeout: number;
  private onStateChange?: (state: { isLeader: boolean }) => void;

  constructor(
    private readonly lockName: string,
    private readonly makeWorker: () => Worker | Promise<Worker>,
    options?: { timeout?: number; onStateChange?: (state: { isLeader: boolean }) => void }
  ) {
    this.timeout = options?.timeout ?? 20_000;
    this.onStateChange = options?.onStateChange;
  }

  /** Start the broker and attempt to acquire leadership */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    // Set up the write handler
    this.writer._setWriteHandler(async (message: Message) => {
      await this.sendMessage(message);
    });

    // Set up broadcast channel for inter-tab communication
    this.broadcastChannel = new BroadcastChannel(this.lockName);
    this.broadcastChannel.addEventListener("message", this.handleBroadcastMessage.bind(this));

    // Try to acquire the lock and become leader - wait until we know our role
    await this.tryAcquireLock();
  }

  private async tryAcquireLock(): Promise<void> {
    let outcomeKnown: (outcome: boolean) => void;
    let outcomeKnownError: (error: Error) => void;
    const outcome = new Promise<boolean>((resolve, reject) => {
      outcomeKnown = resolve;
      outcomeKnownError = reject;
    });

    // First, try to acquire the lock immediately with ifAvailable
    // This allows us to quickly determine if we can be leader or if another tab already has the lock
    // If we can acquire the lock, we are the leader, and we return promptly from start
    // Note: not awaited, because this won't ever return if we do acquire the lock as the leader
    navigator.locks
      .request(this.lockName, { ifAvailable: true }, async (lock) => {
        if (lock === null) {
          // Lock is not available - another tab is the leader
          // We are a follower, so return quickly
          outcomeKnown(false);
          return false;
        }

        // We have the lock! Set up abort controller now
        this.lockAbortController = new AbortController();

        // Become the leader and start the worker
        await this.becomeLeader();

        // Notify the outer world that we are the leader
        outcomeKnown(true);

        // Now hold the lock indefinitely as we are the leader
        return new Promise<void>((resolve) => {
          // If the abort controller is signaled, resolve to release the lock
          this.lockAbortController!.signal.addEventListener("abort", () => {
            resolve();
          });
        });
      })
      .catch(outcomeKnownError!);

    const acquiredLock = await outcome;
    if (!acquiredLock) {
      // We're a follower - the leader exists elsewhere
      this.isLeader = false;
      // Set up abort controller for the follower's lock request
      this.lockAbortController = new AbortController();
      // Try to acquire the lock in the background for failover
      this.waitForLockAndBecomeLeader();

      // Notify state change
      this.onStateChange?.({ isLeader: this.isLeader });
    }
  }

  private waitForLockAndBecomeLeader(): void {
    // Wait indefinitely to acquire the lock for failover
    // This will block until the current leader releases the lock
    // Note: not awaited, because this won't ever return if we do acquire the lock and become the leader
    navigator.locks
      .request(this.lockName, { signal: this.lockAbortController!.signal }, async () => {
        // We got the lock! Become the leader and start the worker
        await this.becomeLeader();

        // Hold the lock indefinitely by waiting on a promise that never resolves
        return new Promise<void>((resolve) => {
          // If the abort controller is signaled, resolve to release the lock
          this.lockAbortController!.signal.addEventListener("abort", () => {
            resolve();
          });
        });
      })
      .catch((error) => {
        // Lock request was aborted or failed
        if (error.name !== "AbortError") {
          console.error("Lock acquisition failed:", error);
          this.reader._emitError(error instanceof Error ? error : new Error(String(error)));
        }
      });
  }

  private async becomeLeader(): Promise<void> {
    this.isLeader = true;

    // Create and start the worker
    this.worker = await this.makeWorker();
    this.worker.addEventListener("message", this.handleWorkerMessage.bind(this));
    this.worker.addEventListener("error", this.handleWorkerError.bind(this));

    // Notify state change
    this.onStateChange?.({ isLeader: this.isLeader });
  }

  private handleWorkerMessage(event: MessageEvent): void {
    const message = event.data as Message;

    // Emit to local listeners
    this.reader._emitMessage(message);

    // Broadcast to other tabs
    if (this.broadcastChannel && this.isLeader) {
      const brokerMessage: BrokerMessage = {
        type: "worker-message",
        message,
      };
      this.broadcastChannel.postMessage(brokerMessage);
    }
  }

  private handleWorkerError(event: ErrorEvent): void {
    const error = new Error(event.message || "Worker error");
    this.reader._emitError(error);
    this.writer._emitError(error);
  }

  private handleBroadcastMessage(event: MessageEvent): void {
    const brokerMessage = event.data as BrokerMessage;

    if (brokerMessage.type === "worker-message") {
      // Message from the leader's worker
      if (!this.isLeader) {
        this.reader._emitMessage(brokerMessage.message);
      }
    } else if (brokerMessage.type === "worker-request") {
      // A follower is requesting us to send a message to the worker
      if (this.isLeader && this.worker) {
        this.worker.postMessage(brokerMessage.message);
        // Send acknowledgment back
        const response: BrokerMessage = {
          type: "worker-response",
          id: brokerMessage.id,
          message: brokerMessage.message,
        };
        this.broadcastChannel!.postMessage(response);
      }
    } else if (brokerMessage.type === "worker-response") {
      // Response to our request
      const pending = this.pendingRequests.get(brokerMessage.id);
      if (pending) {
        pending.resolve(brokerMessage.message);
        this.pendingRequests.delete(brokerMessage.id);
      }
    }
  }

  private async sendMessage(message: Message): Promise<void> {
    if (this.isLeader && this.worker) {
      // We're the leader, send directly to worker
      this.worker.postMessage(message);
    } else {
      // We're a follower, send via broadcast channel to leader
      if (!this.broadcastChannel) {
        throw new Error("Broker not started");
      }

      const requestId = String(this.nextRequestId++);
      const request: BrokerMessage = {
        type: "worker-request",
        id: requestId,
        message,
      };

      // Wait for response from leader
      await new Promise<void>((resolve, reject) => {
        // Set a timeout
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(
            new MultiTabWorkerBrokerError(`MultiTabWorkerBroker request timeout - no leader responded within ${this.timeout}ms`, {
              rpcMessage: message,
            })
          );
        }, this.timeout);

        this.pendingRequests.set(requestId, {
          resolve: () => {
            clearTimeout(timeout);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });

        this.broadcastChannel!.postMessage(request);
      });
    }
  }

  /** Stop the broker and release all resources */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;

    // Release the lock
    if (this.lockAbortController) {
      this.lockAbortController.abort();
      this.lockAbortController = null;
    }

    // Terminate worker if we're the leader
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    // Close broadcast channel
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests.entries()) {
      pending.reject(new Error("Broker stopped"));
    }
    this.pendingRequests.clear();

    // Emit close events
    this.reader._emitClose();
    this.writer._emitClose();

    // Dispose reader and writer
    this.reader.dispose();
    this.writer.dispose();

    const wasLeader = this.isLeader;
    this.isLeader = false;

    // Notify state change if we were the leader
    if (wasLeader) {
      this.onStateChange?.({ isLeader: false });
    }
  }

  /** Dispose the broker */
  dispose(): void {
    void this.stop();
  }
}

class MultiTabMessageReader implements MessageReader {
  private errorEmitter = new Emitter<Error>();
  private closeEmitter = new Emitter<void>();
  private partialMessageEmitter = new Emitter<PartialMessageInfo>();
  private messageEmitter = new Emitter<Message>();
  private disposed = false;

  onError: Event<Error> = this.errorEmitter.event;
  onClose: Event<void> = this.closeEmitter.event;
  onPartialMessage: Event<PartialMessageInfo> = this.partialMessageEmitter.event;

  listen(callback: DataCallback): Disposable {
    return this.messageEmitter.event((message) => {
      callback(message as Message);
    });
  }

  /** Internal method to emit a message to all listeners */
  _emitMessage(message: Message): void {
    if (!this.disposed) {
      this.messageEmitter.fire(message);
    }
  }

  /** Internal method to emit an error to all listeners */
  _emitError(error: Error): void {
    if (!this.disposed) {
      this.errorEmitter.fire(error);
    }
  }

  /** Internal method to emit close event to all listeners */
  _emitClose(): void {
    if (!this.disposed) {
      this.closeEmitter.fire();
    }
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.errorEmitter.dispose();
      this.closeEmitter.dispose();
      this.partialMessageEmitter.dispose();
      this.messageEmitter.dispose();
    }
  }
}

class MultiTabMessageWriter implements MessageWriter {
  private errorEmitter = new Emitter<[Error, Message | undefined, number | undefined]>();
  private closeEmitter = new Emitter<void>();
  private disposed = false;
  private writeHandler: ((message: Message) => Promise<void>) | null = null;

  onError: Event<[Error, Message | undefined, number | undefined]> = this.errorEmitter.event;
  onClose: Event<void> = this.closeEmitter.event;

  async write(message: Message): Promise<void> {
    if (this.disposed) {
      throw new Error("Writer is disposed");
    }
    if (!this.writeHandler) {
      throw new Error("Writer not initialized");
    }
    try {
      await this.writeHandler(message);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.errorEmitter.fire([err, message, undefined]);
      throw err;
    }
  }

  end(): void {
    // Not needed for broker communication
  }

  /** Internal method to set the write handler */
  _setWriteHandler(handler: (message: Message) => Promise<void>): void {
    this.writeHandler = handler;
  }

  /** Internal method to emit an error to all listeners */
  _emitError(error: Error): void {
    if (!this.disposed) {
      this.errorEmitter.fire([error, undefined, undefined]);
    }
  }

  /** Internal method to emit close event to all listeners */
  _emitClose(): void {
    if (!this.disposed) {
      this.closeEmitter.fire();
    }
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.writeHandler = null;
      this.errorEmitter.dispose();
      this.closeEmitter.dispose();
    }
  }
}
