import { Emitter } from "vscode-jsonrpc";
function generateBrokerId() {
    return `broker-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}
export class MultiTabWorkerBrokerError extends Error {
    details;
    constructor(message, details) {
        super(message);
        this.details = details;
        this.name = "MultiTabWorkerBrokerError";
    }
}
/**
 * A worker broker that allows multiple tabs open on the same origin to all talk to one active tab's worker
 * Supports tabs coming and going and re-electing the active tab as leader
 */
export class MultiTabWorkerBroker {
    lockName;
    makeWorker;
    isLeader = false;
    started = false;
    brokerId;
    broadcastChannel = null;
    worker = null;
    lockAbortController = new AbortController();
    pendingRequests = new Map();
    nextRequestId = 0;
    timeout;
    onStateChange;
    // Queue of worker requests received while leader is booting the worker
    leaderRequestQueue = [];
    workerReadyPromise = null;
    workerReadyResolver = null;
    // Map rewritten JSONRPC IDs back to original IDs
    rewrittenIdMap = new Map();
    // Track all active connections (reader/writer pairs)
    connections = new Map();
    nextConnectionId = 0;
    shouldDebug = false;
    // Track the active lock request promise to ensure proper cleanup
    activeLockPromise = null;
    // Track an in-flight stop operation so subsequent starts wait for cleanup
    stopPromise = null;
    constructor(lockName, makeWorker, options) {
        this.lockName = lockName;
        this.makeWorker = makeWorker;
        this.brokerId = generateBrokerId();
        this.timeout = options?.timeout ?? 20_000;
        this.onStateChange = options?.onStateChange;
        this.shouldDebug = options?.debug ?? false;
    }
    /** Central debug logging function */
    debug(message, ...args) {
        if (this.shouldDebug) {
            const role = this.isLeader ? "LEADER" : "FOLLOWER";
            const prefix = `[MTB:${this.brokerId.slice(0, 20)}:${role}]`;
            console.debug(prefix, message, ...args);
        }
    }
    /** Central error logging function */
    error(message, ...args) {
        const role = this.isLeader ? "LEADER" : "FOLLOWER";
        const prefix = `[MTB:${this.brokerId.slice(0, 20)}:${role}]`;
        console.error(prefix, message, ...args);
    }
    /** Create a new connection with independent reader and writer */
    createConnection() {
        const connectionId = String(this.nextConnectionId++);
        const reader = new MultiTabMessageReader();
        const writer = new MultiTabMessageWriter();
        // Set up the write handler for this connection
        writer._setWriteHandler(async (message) => {
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
    async start() {
        if (this.stopPromise) {
            await this.stopPromise;
        }
        if (this.started) {
            return;
        }
        this.started = true;
        // Create a new AbortController for this start cycle
        this.lockAbortController = new AbortController();
        // Set up broadcast channel for inter-tab communication
        this.broadcastChannel = new BroadcastChannel(this.lockName);
        this.broadcastChannel.addEventListener("message", this.handleBroadcastMessage);
        // Try to acquire the lock and become leader - wait until we know our role
        await this.tryAcquireLock();
        this.debug(`Broker started, isLeader=${this.isLeader}`);
    }
    async tryAcquireLock() {
        let outcomeKnown;
        let outcomeKnownError;
        const outcome = new Promise((resolve, reject) => {
            outcomeKnown = resolve;
            outcomeKnownError = reject;
        });
        // First, try to acquire the lock immediately with ifAvailable
        // This allows us to quickly determine if we can be leader or if another tab already has the lock
        // If we can acquire the lock, we are the leader, and we return promptly from start
        // Store the lock promise so we can wait for it to complete during stop()
        this.activeLockPromise = navigator.locks
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
            return new Promise((resolve) => {
                // If the abort controller is signaled, resolve to release the lock
                this.lockAbortController.signal.addEventListener("abort", () => {
                    resolve();
                });
            });
        })
            .catch(outcomeKnownError);
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
    waitForLockAndBecomeLeader() {
        // Wait indefinitely to acquire the lock for failover
        // This will block until the current leader releases the lock
        // Store the lock promise so we can wait for it to complete during stop()
        this.activeLockPromise = navigator.locks
            .request(this.lockName, { signal: this.lockAbortController.signal }, async () => {
            // We got the lock! Become the leader and start the worker
            await this.becomeLeader();
            // Hold the lock indefinitely by waiting on a promise that never resolves
            return new Promise((resolve) => {
                // If the abort controller is signaled, resolve to release the lock
                this.lockAbortController.signal.addEventListener("abort", () => {
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
    async becomeLeader() {
        this.debug(`Becoming leader...`);
        this.isLeader = true;
        // Create and start the worker
        // Set up a promise to signal when the worker is fully ready
        this.workerReadyPromise = new Promise((resolve) => {
            this.workerReadyResolver = resolve;
        });
        this.worker = await this.makeWorker();
        // Set up event listeners
        const messageHandler = (event) => {
            this.handleWorkerMessage(event);
        };
        const errorHandler = (event) => {
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
                const response = { type: "worker-response", id, message };
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
    rewriteId(originalId) {
        // Include a sequence number to handle ID reuse
        const rewrittenId = `${this.brokerId}:${originalId}`;
        this.rewrittenIdMap.set(rewrittenId, originalId);
        return rewrittenId;
    }
    unrewriteId(rewrittenId) {
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
    rewriteMessage(message) {
        // Only rewrite IDs for client->worker requests (messages with a method)
        // Responses (no method) must keep the original ID so the worker can match them
        if (message &&
            typeof message === "object" &&
            "method" in message &&
            message.method &&
            "id" in message &&
            message.id !== undefined) {
            return { ...message, id: this.rewriteId(message.id) };
        }
        return message;
    }
    unrewriteMessage(message) {
        if (message && typeof message === "object" && "id" in message && message.id !== undefined) {
            const { originalId, isOurs } = this.unrewriteId(message.id);
            return { message: { ...message, id: originalId }, isOurs };
        }
        // Messages without IDs (notifications) are broadcast to everyone
        return { message, isOurs: true };
    }
    handleWorkerMessage(event) {
        const message = event.data;
        // If the worker is initiating a request/notification (method present), always deliver locally.
        if (message && typeof message === "object" && "method" in message && message.method) {
            const isNotification = message.id === undefined;
            this.emitToAllConnections(message);
            // Broadcast only notifications to followers so they can observe logs/telemetry, etc.
            if (isNotification && this.broadcastChannel && this.isLeader) {
                const brokerMessage = { type: "worker-message", message };
                this.broadcastChannel.postMessage(brokerMessage);
            }
            return;
        }
        // Else it's a response to a prior request; route to the correct tab based on rewritten ID
        const { message: unrewrittenMessage, isOurs } = this.unrewriteMessage(message);
        if (isOurs) {
            this.emitToAllConnections(unrewrittenMessage);
        }
        else {
            // If the response ID is not a rewritten broker ID (e.g., numeric or plain string),
            // it's most likely intended for the leader (e.g., handshake done outside broker).
            const rawId = message?.id;
            const isRewrittenId = typeof rawId === "string" && rawId.startsWith("broker-");
            if (!isRewrittenId) {
                this.emitToAllConnections(message);
            }
        }
        // Always broadcast responses so followers can pick up their own replies
        if (this.broadcastChannel && this.isLeader) {
            const brokerMessage = { type: "worker-message", message };
            this.broadcastChannel.postMessage(brokerMessage);
        }
    }
    emitToAllConnections(message) {
        for (const { reader } of this.connections.values()) {
            reader._emitMessage(message);
        }
    }
    emitErrorToAllConnections(error) {
        for (const { reader, writer } of this.connections.values()) {
            reader._emitError(error);
            writer._emitError(error);
        }
    }
    emitCloseToAllConnections() {
        for (const { reader, writer } of this.connections.values()) {
            reader._emitClose();
            writer._emitClose();
        }
    }
    handleWorkerError(event) {
        const error = new Error(event.message || "Worker error");
        this.error(`Worker error:`, error, event);
        this.emitErrorToAllConnections(error);
    }
    handleBroadcastMessage = (event) => {
        // Ignore messages if we've been stopped
        if (!this.started) {
            return;
        }
        const brokerMessage = event.data;
        if (brokerMessage.type === "worker-message") {
            // Message from the leader's worker
            if (!this.isLeader) {
                // Un-rewrite the message and only emit if it's for us
                const { message: unrewrittenMessage, isOurs } = this.unrewriteMessage(brokerMessage.message);
                if (isOurs) {
                    this.emitToAllConnections(unrewrittenMessage);
                }
            }
        }
        else if (brokerMessage.type === "worker-request") {
            // A follower is requesting us to send a message to the worker
            if (this.isLeader) {
                if (this.worker) {
                    this.worker.postMessage(brokerMessage.message);
                    // Send acknowledgment back
                    const response = {
                        type: "worker-response",
                        id: brokerMessage.id,
                        message: brokerMessage.message,
                    };
                    this.broadcastChannel.postMessage(response);
                }
                else {
                    // Worker not ready yet; queue the request until worker is available
                    this.leaderRequestQueue.push({ id: brokerMessage.id, message: brokerMessage.message });
                }
            }
        }
        else if (brokerMessage.type === "worker-response") {
            // Response to our request
            const pending = this.pendingRequests.get(brokerMessage.id);
            if (pending) {
                pending.resolve(brokerMessage.message);
                this.pendingRequests.delete(brokerMessage.id);
            }
        }
    };
    async sendMessage(message) {
        const originalId = message?.id;
        this.debug(`sendMessage: originalId=${originalId}`, message);
        // Rewrite the message ID to make it globally unique
        const rewrittenMessage = this.rewriteMessage(message);
        const rewrittenId = rewrittenMessage?.id;
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
        }
        else {
            // We're a follower, send via broadcast channel to leader
            if (!this.broadcastChannel) {
                throw new Error("Broker not started");
            }
            const requestId = String(this.nextRequestId++);
            this.debug(`Sending worker-request: brokerRequestId=${requestId}, rewrittenId=${rewrittenId}`, message);
            const request = {
                type: "worker-request",
                id: requestId,
                message: rewrittenMessage,
            };
            // Wait for response from leader
            await new Promise((resolve, reject) => {
                // Set a timeout
                const timeout = setTimeout(() => {
                    this.pendingRequests.delete(requestId);
                    reject(new MultiTabWorkerBrokerError(`MultiTabWorkerBroker request timeout - no leader responded within ${this.timeout}ms`, {
                        rpcMessage: message,
                    }));
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
                this.broadcastChannel.postMessage(request);
            });
        }
    }
    /** Stop the broker and release all resources */
    async stop() {
        if (this.stopPromise) {
            await this.stopPromise;
            return;
        }
        if (!this.started) {
            return;
        }
        this.started = false;
        const performStop = async () => {
            if (this.lockAbortController) {
                this.lockAbortController.abort();
            }
            const lockPromiseToAwait = this.activeLockPromise;
            if (lockPromiseToAwait) {
                try {
                    await lockPromiseToAwait;
                }
                catch (error) {
                    if (error && error.name !== "AbortError") {
                        this.error("Error while waiting for lock release:", error);
                    }
                }
                this.activeLockPromise = null;
            }
            if (this.worker) {
                this.worker.terminate();
                this.worker = null;
            }
            const channel = this.broadcastChannel;
            if (channel) {
                channel.removeEventListener("message", this.handleBroadcastMessage);
                channel.close();
                this.broadcastChannel = null;
            }
            for (const [id, pending] of this.pendingRequests.entries()) {
                pending.reject(new Error("Broker stopped"));
            }
            this.pendingRequests.clear();
            this.emitCloseToAllConnections();
            for (const { reader, writer } of this.connections.values()) {
                reader.dispose();
                writer.dispose();
            }
            this.connections.clear();
            this.workerReadyPromise = null;
            this.workerReadyResolver = null;
            this.leaderRequestQueue = [];
            this.rewrittenIdMap.clear();
            const wasLeader = this.isLeader;
            this.isLeader = false;
            if (wasLeader) {
                this.onStateChange?.({ isLeader: false });
            }
        };
        this.stopPromise = (async () => {
            try {
                await performStop();
            }
            finally {
                this.stopPromise = null;
            }
        })();
        await this.stopPromise;
    }
}
class MultiTabMessageReader {
    errorEmitter = new Emitter();
    closeEmitter = new Emitter();
    partialMessageEmitter = new Emitter();
    messageEmitter = new Emitter();
    disposed = false;
    hasListener = false;
    queuedMessages = [];
    static MAX_QUEUE = 1000;
    onError = this.errorEmitter.event;
    onClose = this.closeEmitter.event;
    onPartialMessage = this.partialMessageEmitter.event;
    listen(callback) {
        const disposable = this.messageEmitter.event((message) => {
            callback(message);
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
    _emitMessage(message) {
        if (!this.disposed) {
            if (this.hasListener) {
                this.messageEmitter.fire(message);
            }
            else {
                // Queue until a listener is attached
                if (this.queuedMessages.length >= MultiTabMessageReader.MAX_QUEUE) {
                    // Drop oldest to prevent unbounded growth
                    this.queuedMessages.shift();
                }
                this.queuedMessages.push(message);
            }
        }
    }
    _emitError(error) {
        if (!this.disposed) {
            this.errorEmitter.fire(error);
        }
    }
    _emitClose() {
        if (!this.disposed) {
            this.closeEmitter.fire();
        }
    }
    dispose() {
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
class MultiTabMessageWriter {
    errorEmitter = new Emitter();
    closeEmitter = new Emitter();
    disposed = false;
    writeHandler = null;
    onError = this.errorEmitter.event;
    onClose = this.closeEmitter.event;
    async write(message) {
        if (this.disposed) {
            throw new Error("Writer is disposed");
        }
        if (!this.writeHandler) {
            throw new Error("Writer not initialized");
        }
        try {
            await this.writeHandler(message);
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.errorEmitter.fire([err, message, undefined]);
            throw err;
        }
    }
    end() {
        // Not needed for broker communication
    }
    _setWriteHandler(handler) {
        this.writeHandler = handler;
    }
    _emitError(error) {
        if (!this.disposed) {
            this.errorEmitter.fire([error, undefined, undefined]);
        }
    }
    _emitClose() {
        if (!this.disposed) {
            this.closeEmitter.fire();
        }
    }
    dispose() {
        if (!this.disposed) {
            this.disposed = true;
            this.writeHandler = null;
            this.errorEmitter.dispose();
            this.closeEmitter.dispose();
        }
    }
}
