import { Disposable, Event, Emitter, MessageReader, MessageWriter, DataCallback, PartialMessageInfo, Message } from "vscode-jsonrpc";

function generateBrokerId(): string {
  return `broker-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

type BrokerMessage =
  | { type: "worker-message"; message: Message }
  | { type: "worker-request"; id: string; message: Message }
  | { type: "worker-response"; id: string; message: Message };

export class MultiTabWorkerBrokerError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) {
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

  private readonly brokerId: string;
  private broadcastChannel: BroadcastChannel | null = null;
  private worker: Worker | null = null;
  private lockAbortController = new AbortController();
  private pendingRequests = new Map<string, { resolve: (message: Message) => void; reject: (error: Error) => void }>();
  private nextRequestId = 0;
  private started = false;
  private timeout: number;
  private onStateChange?: (state: { isLeader: boolean }) => void;
  // Queue of worker requests received while leader is booting the worker
  private leaderRequestQueue: Array<{ id: string; message: Message }> = [];
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolver: (() => void) | null = null;
  // Map rewritten JSONRPC IDs back to original IDs
  private rewrittenIdMap = new Map<string, string | number>();
  // Track all active connections (reader/writer pairs)
  private connections = new Map<string, { reader: MultiTabMessageReader; writer: MultiTabMessageWriter }>();
  private nextConnectionId = 0;
  private shouldDebug = false;

  constructor(
    private readonly lockName: string,
    private readonly makeWorker: () => Worker | Promise<Worker>,
    options?: { timeout?: number; onStateChange?: (state: { isLeader: boolean }) => void; debug?: boolean }
  ) {
    this.brokerId = generateBrokerId();
    this.timeout = options?.timeout ?? 20_000;
    this.onStateChange = options?.onStateChange;
    this.shouldDebug = options?.debug ?? false;
  }

  /** Central debug logging function */
  private debug(message: string, ...args: any[]): void {
    if (this.shouldDebug) {
      const role = this.isLeader ? "LEADER" : "FOLLOWER";
      const prefix = `[MTB:${this.brokerId.slice(0, 20)}:${role}]`;
      console.debug(prefix, message, ...args);
    }
  }

  /** Central error logging function */
  private error(message: string, ...args: any[]): void {
    const role = this.isLeader ? "LEADER" : "FOLLOWER";
    const prefix = `[MTB:${this.brokerId.slice(0, 20)}:${role}]`;
    console.error(prefix, message, ...args);
  }

  /** Create a new connection with independent reader and writer */
  createConnection(): { reader: MessageReader; writer: MessageWriter; dispose: () => void } {
    const connectionId = String(this.nextConnectionId++);
    const reader = new MultiTabMessageReader();
    const writer = new MultiTabMessageWriter();

    // Set up the write handler for this connection
    writer._setWriteHandler(async (message: Message) => {
      await this.sendMessage(message);
    });

    // Track this connection
    this.connections.set(connectionId, { reader, writer });

    this.debug(`createConnection: Created connection ${connectionId}`);

    // Return disposal function
    const dispose = () => {
      this.debug(`Connection ${connectionId} disposed`);
      const conn = this.connections.get(connectionId);
      if (conn) {
        conn.reader.dispose();
        conn.writer.dispose();
        this.connections.delete(connectionId);
      }
    };

    return { reader, writer, dispose };
  }

  /** Start the broker and attempt to acquire leadership */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    // Create a new AbortController for this start cycle
    this.lockAbortController = new AbortController();

    // Set up broadcast channel for inter-tab communication
    this.broadcastChannel = new BroadcastChannel(this.lockName);
    this.broadcastChannel.addEventListener("message", this.handleBroadcastMessage.bind(this));

    // Try to acquire the lock and become leader - wait until we know our role
    await this.tryAcquireLock();
    this.debug(`Broker started, isLeader=${this.isLeader}`);
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
          this.error(`Lock acquisition failed:`, error);
          this.emitErrorToAllConnections(error instanceof Error ? error : new Error(String(error)));
        }
      });
  }

  private async becomeLeader(): Promise<void> {
    this.debug(`Becoming leader...`);
    this.isLeader = true;

    // Create and start the worker
    // Set up a promise to signal when the worker is fully ready
    this.workerReadyPromise = new Promise<void>((resolve) => {
      this.workerReadyResolver = resolve;
    });
    this.worker = await this.makeWorker();

    // Set up event listeners
    const messageHandler = (event: MessageEvent) => {
      this.handleWorkerMessage(event);
    };
    const errorHandler = (event: ErrorEvent) => {
      this.handleWorkerError(event);
    };

    this.worker.addEventListener("message", messageHandler);
    this.worker.addEventListener("error", errorHandler);

    this.debug(`Leader ready with worker`);

    // Notify state change
    this.onStateChange?.({ isLeader: this.isLeader });

    // Drain any queued follower requests that arrived while booting
    if (this.leaderRequestQueue.length > 0 && this.worker && this.broadcastChannel) {
      const queued = this.leaderRequestQueue.splice(0, this.leaderRequestQueue.length);
      for (const { id, message } of queued) {
        this.worker.postMessage(message);
        const response: BrokerMessage = { type: "worker-response", id, message };
        this.broadcastChannel.postMessage(response);
      }
    }

    // Signal readiness to any pending local sends
    if (this.workerReadyResolver) {
      this.workerReadyResolver();
      this.workerReadyResolver = null;
    }
  }

  /** Rewrite a JSONRPC ID to make it globally unique */
  private rewriteId(originalId: string | number): string {
    // Include a sequence number to handle ID reuse
    const rewrittenId = `${this.brokerId}:${originalId}`;
    this.rewrittenIdMap.set(rewrittenId, originalId);
    return rewrittenId;
  }

  private unrewriteId(rewrittenId: string | number): { originalId: string | number; isOurs: boolean } {
    // Check if this ID is one of ours
    if (typeof rewrittenId === "string" && rewrittenId.startsWith(`${this.brokerId}:`)) {
      const originalId = this.rewrittenIdMap.get(rewrittenId);
      if (originalId !== undefined) {
        this.rewrittenIdMap.delete(rewrittenId);
        return { originalId, isOurs: true };
      }
    }
    return { originalId: rewrittenId, isOurs: false };
  }

  private rewriteMessage(message: Message): Message {
    // Only rewrite IDs for client->worker requests (messages with a method)
    // Responses (no method) must keep the original ID so the worker can match them
    if (
      message &&
      typeof message === "object" &&
      "method" in (message as any) &&
      (message as any).method &&
      "id" in message &&
      (message as any).id !== undefined
    ) {
      return { ...(message as any), id: this.rewriteId((message as any).id as string | number) } as Message;
    }
    return message;
  }

  private unrewriteMessage(message: Message): { message: Message; isOurs: boolean } {
    if (message && typeof message === "object" && "id" in message && message.id !== undefined) {
      const { originalId, isOurs } = this.unrewriteId(message.id as string | number);
      return { message: { ...(message as any), id: originalId } as Message, isOurs };
    }
    // Messages without IDs (notifications) are broadcast to everyone
    return { message, isOurs: true };
  }

  private handleWorkerMessage(event: MessageEvent): void {
    const message = event.data as Message;

    // If the worker is initiating a request/notification (method present), always deliver locally.
    if (message && typeof message === "object" && "method" in (message as any) && (message as any).method) {
      const isNotification = (message as any).id === undefined;
      this.emitToAllConnections(message);

      // Broadcast only notifications to followers so they can observe logs/telemetry, etc.
      if (isNotification && this.broadcastChannel && this.isLeader) {
        const brokerMessage: BrokerMessage = { type: "worker-message", message };
        this.broadcastChannel.postMessage(brokerMessage);
      }
      return;
    }

    // Else it's a response to a prior request; route to the correct tab based on rewritten ID
    const { message: unrewrittenMessage, isOurs } = this.unrewriteMessage(message);
    if (isOurs) {
      this.emitToAllConnections(unrewrittenMessage);
    } else {
      // If the response ID is not a rewritten broker ID (e.g., numeric or plain string),
      // it's most likely intended for the leader (e.g., handshake done outside broker).
      const rawId = (message as any)?.id;
      const isRewrittenId = typeof rawId === "string" && rawId.startsWith("broker-");
      if (!isRewrittenId) {
        this.emitToAllConnections(message);
      }
    }

    // Always broadcast responses so followers can pick up their own replies
    if (this.broadcastChannel && this.isLeader) {
      const brokerMessage: BrokerMessage = { type: "worker-message", message };
      this.broadcastChannel.postMessage(brokerMessage);
    }
  }

  private emitToAllConnections(message: Message): void {
    for (const { reader } of this.connections.values()) {
      reader._emitMessage(message);
    }
  }

  private emitErrorToAllConnections(error: Error): void {
    for (const { reader, writer } of this.connections.values()) {
      reader._emitError(error);
      writer._emitError(error);
    }
  }

  private emitCloseToAllConnections(): void {
    for (const { reader, writer } of this.connections.values()) {
      reader._emitClose();
      writer._emitClose();
    }
  }

  private handleWorkerError(event: ErrorEvent): void {
    const error = new Error(event.message || "Worker error");
    this.error(`Worker error:`, error, event);
    this.emitErrorToAllConnections(error);
  }

  private handleBroadcastMessage(event: MessageEvent): void {
    const brokerMessage = event.data as BrokerMessage;

    if (brokerMessage.type === "worker-message") {
      // Message from the leader's worker
      if (!this.isLeader) {
        // Un-rewrite the message and only emit if it's for us
        const { message: unrewrittenMessage, isOurs } = this.unrewriteMessage(brokerMessage.message);
        if (isOurs) {
          this.emitToAllConnections(unrewrittenMessage);
        }
      }
    } else if (brokerMessage.type === "worker-request") {
      // A follower is requesting us to send a message to the worker
      if (this.isLeader) {
        if (this.worker) {
          this.worker.postMessage(brokerMessage.message);
          // Send acknowledgment back
          const response: BrokerMessage = {
            type: "worker-response",
            id: brokerMessage.id,
            message: brokerMessage.message,
          };
          this.broadcastChannel!.postMessage(response);
        } else {
          // Worker not ready yet; queue the request until worker is available
          this.leaderRequestQueue.push({ id: brokerMessage.id, message: brokerMessage.message });
        }
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
    const originalId = (message as any)?.id;
    this.debug(`sendMessage: originalId=${originalId}`, message);

    // Rewrite the message ID to make it globally unique
    const rewrittenMessage = this.rewriteMessage(message);
    const rewrittenId = (rewrittenMessage as any)?.id;

    if (this.isLeader) {
      // If leader but worker not ready yet, wait until ready
      if (!this.worker) {
        this.debug(`Leader not ready; waiting for worker to initialize`);
        if (this.workerReadyPromise) {
          await this.workerReadyPromise;
        }
      }
      if (this.worker) {
        this.debug(`Sending to worker with rewrittenId=${rewrittenId}`, message);
        this.worker.postMessage(rewrittenMessage);
        return;
      }
      // Fallback if still no worker (should not happen): broadcast as follower
      this.debug(`Worker still not available after wait; falling back to broadcast`);
    } else {
      // We're a follower, send via broadcast channel to leader
      if (!this.broadcastChannel) {
        throw new Error("Broker not started");
      }

      const requestId = String(this.nextRequestId++);
      this.debug(`Sending worker-request: brokerRequestId=${requestId}, rewrittenId=${rewrittenId}`, message);

      const request: BrokerMessage = {
        type: "worker-request",
        id: requestId,
        message: rewrittenMessage,
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

    // Emit close events to all connections
    this.emitCloseToAllConnections();

    // Dispose all connections
    for (const { reader, writer } of this.connections.values()) {
      reader.dispose();
      writer.dispose();
    }
    this.connections.clear();

    // Reset worker state
    this.workerReadyPromise = null;
    this.workerReadyResolver = null;
    this.leaderRequestQueue = [];
    this.rewrittenIdMap.clear();

    const wasLeader = this.isLeader;
    this.isLeader = false;

    // Notify state change if we were the leader
    if (wasLeader) {
      this.onStateChange?.({ isLeader: false });
    }
  }
}

class MultiTabMessageReader implements MessageReader {
  private errorEmitter = new Emitter<Error>();
  private closeEmitter = new Emitter<void>();
  private partialMessageEmitter = new Emitter<PartialMessageInfo>();
  private messageEmitter = new Emitter<Message>();
  private disposed = false;
  private hasListener = false;
  private queuedMessages: Message[] = [];
  private static readonly MAX_QUEUE = 1000;

  onError: Event<Error> = this.errorEmitter.event;
  onClose: Event<void> = this.closeEmitter.event;
  onPartialMessage: Event<PartialMessageInfo> = this.partialMessageEmitter.event;

  listen(callback: DataCallback): Disposable {
    const disposable = this.messageEmitter.event((message) => {
      callback(message as Message);
    });
    if (!this.hasListener) {
      this.hasListener = true;
      // Flush any queued messages in order now that a listener is attached
      if (this.queuedMessages.length > 0) {
        const toFlush = this.queuedMessages.splice(0, this.queuedMessages.length);
        for (const msg of toFlush) {
          this.messageEmitter.fire(msg);
        }
      }
    }
    return disposable;
  }

  _emitMessage(message: Message): void {
    if (!this.disposed) {
      if (this.hasListener) {
        this.messageEmitter.fire(message);
      } else {
        // Queue until a listener is attached
        if (this.queuedMessages.length >= MultiTabMessageReader.MAX_QUEUE) {
          // Drop oldest to prevent unbounded growth
          this.queuedMessages.shift();
        }
        this.queuedMessages.push(message);
      }
    }
  }

  _emitError(error: Error): void {
    if (!this.disposed) {
      this.errorEmitter.fire(error);
    }
  }

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
      this.queuedMessages = [];
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

  _setWriteHandler(handler: (message: Message) => Promise<void>): void {
    this.writeHandler = handler;
  }

  _emitError(error: Error): void {
    if (!this.disposed) {
      this.errorEmitter.fire([error, undefined, undefined]);
    }
  }

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
