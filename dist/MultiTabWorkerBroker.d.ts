import { MessageReader, MessageWriter } from "vscode-jsonrpc";
export declare class MultiTabWorkerBrokerError extends Error {
    readonly details?: Record<string, unknown> | undefined;
    constructor(message: string, details?: Record<string, unknown> | undefined);
}
/**
 * A worker broker that allows multiple tabs open on the same origin to all talk to one active tab's worker
 * Supports tabs coming and going and re-electing the active tab as leader
 */
export declare class MultiTabWorkerBroker {
    private readonly lockName;
    private readonly makeWorker;
    isLeader: boolean;
    private readonly brokerId;
    private broadcastChannel;
    private worker;
    private lockAbortController;
    private pendingRequests;
    private nextRequestId;
    private started;
    private timeout;
    private onStateChange?;
    private leaderRequestQueue;
    private workerReadyPromise;
    private workerReadyResolver;
    private rewrittenIdMap;
    private rewriteSequence;
    private connections;
    private nextConnectionId;
    constructor(lockName: string, makeWorker: () => Worker | Promise<Worker>, options?: {
        timeout?: number;
        onStateChange?: (state: {
            isLeader: boolean;
        }) => void;
    });
    /** Central debug logging function */
    private debug;
    /** Central error logging function */
    private error;
    /** Create a new connection with independent reader and writer */
    createConnection(): {
        reader: MessageReader;
        writer: MessageWriter;
        dispose: () => void;
    };
    /** Start the broker and attempt to acquire leadership */
    start(): Promise<void>;
    private tryAcquireLock;
    private waitForLockAndBecomeLeader;
    private becomeLeader;
    /** Rewrite a JSONRPC ID to make it globally unique */
    private rewriteId;
    /** Un-rewrite a JSONRPC ID back to its original form */
    private unrewriteId;
    /** Rewrite message IDs if present */
    private rewriteMessage;
    /** Un-rewrite message IDs if present and they belong to us */
    private unrewriteMessage;
    private handleWorkerMessage;
    /** Emit a message to all active connections */
    private emitToAllConnections;
    /** Emit an error to all active connections */
    private emitErrorToAllConnections;
    /** Emit close event to all active connections */
    private emitCloseToAllConnections;
    private handleWorkerError;
    private handleBroadcastMessage;
    private sendMessage;
    /** Stop the broker and release all resources */
    stop(): Promise<void>;
    /** Dispose the broker */
    dispose(): void;
}
