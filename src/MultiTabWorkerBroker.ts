export interface Disposable {
  /**
   * Dispose this object.
   */
  dispose(): void;
}

/** Reads messages from the worker. */
export interface MessageReader<T> {
  /** Add a callback to be called whenever an error occurs while reading a message. */
  onError(listener: (error: Error) => void): Disposable;
  /** Add a callback to be called when the end of the underlying transport has been reached. */
  onClose(listener: () => void): Disposable;
  /**
   * Begins listening for incoming messages. To be called at most once.
   * @param callback A callback for receiving decoded messages.
   */
  listen(callback: (message: T) => void): Disposable;

  /** Releases resources incurred from reading or raising events. Does NOT close the underlying transport, if any. */
  dispose(): void;
}

export interface MessageWriter<T> {
  /**
   * Raised whenever an error occurs while writing a message.
   */
  onError(listener: (error: Error) => void): Disposable;
  /**
   * An event raised when the underlying transport has closed and writing is no longer possible.
   */
  onClose(listener: () => void): Disposable;
  /**
   * Sends a message to the active worker.
   * @param message The message to be sent.
   */
  write(message: T): Promise<void>;

  /** Releases resources incurred from writing or raising events. Does NOT close the underlying transport, if any. */
  dispose(): void;
}

type BrokerMessage<T> =
  | { type: "worker-message"; message: T }
  | { type: "worker-request"; id: string; message: T }
  | { type: "worker-response"; id: string; message: T };

class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];

  on(listener: (value: T) => void): Disposable {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) {
          this.listeners.splice(index, 1);
        }
      },
    };
  }

  emit(value: T): void {
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch (error) {
        console.error("Error in event listener:", error);
      }
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

class MultiTabMessageReader<T> implements MessageReader<T> {
  private errorEmitter = new EventEmitter<Error>();
  private closeEmitter = new EventEmitter<void>();
  private messageEmitter = new EventEmitter<T>();
  private disposed = false;

  onError(listener: (error: Error) => void): Disposable {
    return this.errorEmitter.on(listener);
  }

  onClose(listener: () => void): Disposable {
    return this.closeEmitter.on(listener);
  }

  listen(callback: (message: T) => void): Disposable {
    return this.messageEmitter.on(callback);
  }

  /** Internal method to emit a message to all listeners */
  _emitMessage(message: T): void {
    if (!this.disposed) {
      this.messageEmitter.emit(message);
    }
  }

  /** Internal method to emit an error to all listeners */
  _emitError(error: Error): void {
    if (!this.disposed) {
      this.errorEmitter.emit(error);
    }
  }

  /** Internal method to emit close event to all listeners */
  _emitClose(): void {
    if (!this.disposed) {
      this.closeEmitter.emit();
    }
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.errorEmitter.dispose();
      this.closeEmitter.dispose();
      this.messageEmitter.dispose();
    }
  }
}

class MultiTabMessageWriter<T> implements MessageWriter<T> {
  private errorEmitter = new EventEmitter<Error>();
  private closeEmitter = new EventEmitter<void>();
  private disposed = false;
  private writeHandler: ((message: T) => Promise<void>) | null = null;

  onError(listener: (error: Error) => void): Disposable {
    return this.errorEmitter.on(listener);
  }

  onClose(listener: () => void): Disposable {
    return this.closeEmitter.on(listener);
  }

  async write(message: T): Promise<void> {
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
      this.errorEmitter.emit(err);
      throw err;
    }
  }

  /** Internal method to set the write handler */
  _setWriteHandler(handler: (message: T) => Promise<void>): void {
    this.writeHandler = handler;
  }

  /** Internal method to emit an error to all listeners */
  _emitError(error: Error): void {
    if (!this.disposed) {
      this.errorEmitter.emit(error);
    }
  }

  /** Internal method to emit close event to all listeners */
  _emitClose(): void {
    if (!this.disposed) {
      this.closeEmitter.emit();
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

/**
 * A worker broker that allows multiple tabs open on the same origin to all talk to one active tab's worker
 * Supports tabs coming and going and re-electing the active tab as leader
 */
export class MultiTabWorkerBroker<T> {
  private _reader = new MultiTabMessageReader<T>();
  private _writer = new MultiTabMessageWriter<T>();
  private broadcastChannel: BroadcastChannel | null = null;
  private worker: Worker | null = null;
  private isLeader = false;
  private lockAbortController: AbortController | null = null;
  private pendingRequests = new Map<string, { resolve: (message: T) => void; reject: (error: Error) => void }>();
  private nextRequestId = 0;
  private started = false;
  private timeout: number;

  constructor(
    private readonly lockName: string,
    private readonly makeWorker: () => Worker | Promise<Worker>,
    options?: { timeout?: number }
  ) {
    this.timeout = options?.timeout ?? 20_000;
  }

  get reader(): MessageReader<T> {
    return this._reader;
  }

  get writer(): MessageWriter<T> {
    return this._writer;
  }

  /** Start the broker and attempt to acquire leadership */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    // Set up the write handler
    this._writer._setWriteHandler(async (message: T) => {
      await this.sendMessage(message);
    });

    // Set up broadcast channel for inter-tab communication
    this.broadcastChannel = new BroadcastChannel(this.lockName);
    this.broadcastChannel.addEventListener("message", this.handleBroadcastMessage.bind(this));

    // Try to acquire the lock and become leader
    this.tryAcquireLock();
  }

  private tryAcquireLock(): void {
    this.lockAbortController = new AbortController();

    navigator.locks
      .request(this.lockName, { signal: this.lockAbortController.signal }, async () => {
        // We have the lock! Become the leader
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
          this._reader._emitError(error instanceof Error ? error : new Error(String(error)));
        }
      });
  }

  private async becomeLeader(): Promise<void> {
    this.isLeader = true;

    // Create and start the worker
    this.worker = await this.makeWorker();
    this.worker.addEventListener("message", this.handleWorkerMessage.bind(this));
    this.worker.addEventListener("error", this.handleWorkerError.bind(this));
  }

  private handleWorkerMessage(event: MessageEvent): void {
    const message = event.data as T;

    // Emit to local listeners
    this._reader._emitMessage(message);

    // Broadcast to other tabs
    if (this.broadcastChannel && this.isLeader) {
      const brokerMessage: BrokerMessage<T> = {
        type: "worker-message",
        message,
      };
      this.broadcastChannel.postMessage(brokerMessage);
    }
  }

  private handleWorkerError(event: ErrorEvent): void {
    const error = new Error(event.message || "Worker error");
    this._reader._emitError(error);
    this._writer._emitError(error);
  }

  private handleBroadcastMessage(event: MessageEvent): void {
    const brokerMessage = event.data as BrokerMessage<T>;

    if (brokerMessage.type === "worker-message") {
      // Message from the leader's worker
      if (!this.isLeader) {
        this._reader._emitMessage(brokerMessage.message);
      }
    } else if (brokerMessage.type === "worker-request") {
      // A follower is requesting us to send a message to the worker
      if (this.isLeader && this.worker) {
        this.worker.postMessage(brokerMessage.message);
        // Send acknowledgment back
        const response: BrokerMessage<T> = {
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

  private async sendMessage(message: T): Promise<void> {
    if (this.isLeader && this.worker) {
      // We're the leader, send directly to worker
      this.worker.postMessage(message);
    } else {
      // We're a follower, send via broadcast channel to leader
      if (!this.broadcastChannel) {
        throw new Error("Broker not started");
      }

      const requestId = String(this.nextRequestId++);
      const request: BrokerMessage<T> = {
        type: "worker-request",
        id: requestId,
        message,
      };

      // Wait for response from leader
      await new Promise<void>((resolve, reject) => {
        // Set a timeout
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error("Request timeout - no leader available"));
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

  /** Check if this broker is currently the leader */
  getIsLeader(): boolean {
    return this.isLeader;
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
    this._reader._emitClose();
    this._writer._emitClose();

    // Dispose reader and writer
    this._reader.dispose();
    this._writer.dispose();

    this.isLeader = false;
  }

  /** Dispose the broker */
  dispose(): void {
    void this.stop();
  }
}
