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
    private connections;
    private nextConnectionId;
    private shouldDebug;
    private activeLockPromise;
    constructor(lockName: string, makeWorker: () => Worker | Promise<Worker>, options?: {
        timeout?: number;
        onStateChange?: (state: {
            isLeader: boolean;
        }) => void;
        debug?: boolean;
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
    private unrewriteId;
    private rewriteMessage;
    private unrewriteMessage;
    private handleWorkerMessage;
    private emitToAllConnections;
    private emitErrorToAllConnections;
    private emitCloseToAllConnections;
    private handleWorkerError;
    private handleBroadcastMessage;
    private sendMessage;
    /** Stop the broker and release all resources */
    stop(): Promise<void>;
}
