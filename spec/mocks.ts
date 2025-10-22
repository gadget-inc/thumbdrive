// Mock BroadcastChannel
export class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  listeners: Map<string, Set<(event: any) => void>> = new Map();
  name: string;
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  addEventListener(event: string, listener: (event: any) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  removeEventListener(event: string, listener: (event: any) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  postMessage(data: any) {
    // Simulate broadcasting to all other instances with the same name
    MockBroadcastChannel.instances
      .filter((ch) => ch !== this && ch.name === this.name && !ch.closed)
      .forEach((ch) => {
        const listeners = ch.listeners.get("message");
        if (listeners) {
          listeners.forEach((listener) => listener({ data }));
        }
      });
  }

  close() {
    this.closed = true;
    const index = MockBroadcastChannel.instances.indexOf(this);
    if (index !== -1) {
      MockBroadcastChannel.instances.splice(index, 1);
    }
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}
// Mock navigator.locks
interface LockRequest {
  name: string;
  callback: (lock: any) => Promise<void>;
  signal?: AbortSignal;
  ifAvailable?: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}
export class MockLockManager {
  private activeLocks = new Map<string, LockRequest>();
  private pendingRequests: LockRequest[] = [];

  async request(
    name: string,
    options: { signal?: AbortSignal; ifAvailable?: boolean } | ((lock: any) => Promise<void>),
    callback?: (lock: any) => Promise<void>
  ): Promise<void> {
    let actualCallback: (lock: any) => Promise<void>;
    let signal: AbortSignal | undefined;
    let ifAvailable: boolean | undefined;

    if (typeof options === "function") {
      actualCallback = options;
    } else {
      actualCallback = callback!;
      signal = options.signal;
      ifAvailable = options.ifAvailable;

      // Match real browser behavior: can't use signal and ifAvailable together
      if (signal && ifAvailable) {
        throw new DOMException("The 'signal' and 'ifAvailable' options cannot be used together.", "NotSupportedError");
      }
    }

    return new Promise<void>((resolve, reject) => {
      const request: LockRequest = {
        name,
        callback: actualCallback as any,
        signal,
        ifAvailable,
        resolve,
        reject,
      };

      // Listen for abort signal
      if (signal) {
        signal.addEventListener("abort", () => {
          this.abortRequest(request);
        });
      }

      // If no lock is held, grant it immediately
      if (!this.activeLocks.has(name)) {
        this.grantLock(request);
      } else if (ifAvailable) {
        // If ifAvailable is true and lock is not available, call callback with null immediately
        this.grantLockWithNull(request);
      } else {
        this.pendingRequests.push(request);
      }
    });
  }

  private async grantLock(request: LockRequest) {
    if (request.signal?.aborted) {
      request.reject(new Error("AbortError"));
      return;
    }

    this.activeLocks.set(request.name, request);

    try {
      await request.callback({});
      this.releaseLock(request.name);
      request.resolve();
    } catch (error) {
      this.releaseLock(request.name);
      request.reject(error as Error);
    }
  }

  private async grantLockWithNull(request: LockRequest) {
    if (request.signal?.aborted) {
      request.reject(new Error("AbortError"));
      return;
    }

    try {
      await request.callback(null);
      request.resolve();
    } catch (error) {
      request.reject(error as Error);
    }
  }

  private releaseLock(name: string) {
    this.activeLocks.delete(name);

    // Grant lock to next pending request for this name
    const nextIndex = this.pendingRequests.findIndex((r) => r.name === name);
    if (nextIndex !== -1) {
      const next = this.pendingRequests.splice(nextIndex, 1)[0];
      this.grantLock(next);
    }
  }

  private abortRequest(request: LockRequest) {
    const error = new Error("AbortError");
    (error as any).name = "AbortError";

    // Remove from pending if it's there
    const index = this.pendingRequests.indexOf(request);
    if (index !== -1) {
      this.pendingRequests.splice(index, 1);
      request.reject(error);
    }

    // If it's the active lock, release it
    if (this.activeLocks.get(request.name) === request) {
      this.releaseLock(request.name);
      request.resolve(); // The promise from the callback resolves when aborted
    }
  }

  reset(): void {
    this.activeLocks.clear();
    this.pendingRequests = [];
  }
}
