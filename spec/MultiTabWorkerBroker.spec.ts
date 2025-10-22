import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MultiTabWorkerBroker } from "../src/MultiTabWorkerBroker";
import { MockLockManager, MockBroadcastChannel } from "./mocks";

describe("MultiTabWorkerBroker", () => {
  let makeWorker: () => Worker;
  let mockLocks: MockLockManager;
  let workers: Worker[] = [];
  let testCounter = 0;
  let getLockName: () => string;

  beforeEach(() => {
    // Create unique lock name for each test
    const lockName = `test-lock-${testCounter++}`;
    getLockName = () => lockName;

    // Create worker factory that uses real workers
    makeWorker = () => {
      const worker = new Worker(new URL("./test-worker.ts", import.meta.url), { type: "module" });
      workers.push(worker);
      return worker;
    };

    // Mock BroadcastChannel
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    MockBroadcastChannel.reset();

    // Mock navigator.locks
    mockLocks = new MockLockManager();
    vi.stubGlobal("navigator", {
      locks: mockLocks,
    });
  });

  afterEach(async () => {
    // Clean up all workers
    workers.forEach((w) => w.terminate());
    workers = [];

    // Give workers a moment to fully terminate
    await new Promise((resolve) => setTimeout(resolve, 10));

    MockBroadcastChannel.reset();
    mockLocks.reset();
    vi.unstubAllGlobals();
  });

  it("should create a broker with reader and writer", () => {
    const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);

    expect(broker.reader).toBeDefined();
    expect(broker.writer).toBeDefined();
    expect(broker.isLeader).toBe(false);
  });

  describe("lifecycle", () => {
    it("should start and acquire leadership", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);

      await broker.start();

      expect(broker.isLeader).toBe(true);

      await broker.stop();
    });

    it("should not start twice", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);
      const makeWorkerSpy = vi.fn(makeWorker);
      const broker2 = new MultiTabWorkerBroker(getLockName() + "-other", makeWorkerSpy);

      await broker2.start();
      await broker2.start(); // Second call should be no-op

      expect(makeWorkerSpy).toHaveBeenCalledTimes(1);

      await broker.stop();
      await broker2.stop();
    });

    it("should stop cleanly", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);

      await broker.start();

      expect(broker.isLeader).toBe(true);

      await broker.stop();

      expect(broker.isLeader).toBe(false);
    });

    it("should not fail when stopping before starting", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);
      await expect(broker.stop()).resolves.toBeUndefined();
    });
  });

  describe("reader", () => {
    it("should receive messages from worker when leader", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);
      const messages: any[] = [];

      broker.reader.listen((msg) => messages.push(msg));

      await broker.start();

      // Write a message - the test worker will echo it back
      await broker.writer.write({ type: "test", data: "hello" } as any);

      // Wait for the echo
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "test", data: "hello" });

      await broker.stop();
    });

    it("should forward worker messages to other tabs via broadcast", async () => {
      const lockName = getLockName();
      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker);
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker);

      const messages1: any[] = [];
      const messages2: any[] = [];

      broker1.reader.listen((msg) => messages1.push(msg));
      broker2.reader.listen((msg) => messages2.push(msg));

      // Start broker1 (becomes leader)
      await broker1.start();

      // Start broker2 (becomes follower)
      await broker2.start();

      expect(broker1.isLeader).toBe(true);
      expect(broker2.isLeader).toBe(false);

      // Send a message from leader - worker will echo it back
      await broker1.writer.write({ type: "test", data: "broadcast" } as any);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Both brokers should receive the message
      expect(messages1).toHaveLength(1);
      expect(messages2).toHaveLength(1);
      expect(messages1[0]).toEqual({ type: "test", data: "broadcast" });
      expect(messages2[0]).toEqual({ type: "test", data: "broadcast" });

      await broker1.stop();
      await broker2.stop();
    });

    it("should support multiple listeners", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);
      const messages1: any[] = [];
      const messages2: any[] = [];

      broker.reader.listen((msg) => messages1.push(msg));
      broker.reader.listen((msg) => messages2.push(msg));

      await broker.start();

      await broker.writer.write({ type: "test" } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages1).toHaveLength(1);
      expect(messages2).toHaveLength(1);

      await broker.stop();
    });

    it("should allow listeners to be disposed", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);
      const messages: any[] = [];

      const disposable = broker.reader.listen((msg) => messages.push(msg));

      await broker.start();

      await broker.writer.write({ type: "test1" } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      disposable.dispose();

      await broker.writer.write({ type: "test2" } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("test1");

      await broker.stop();
    });
  });

  describe("writer", () => {
    it("should send messages to worker when leader", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);
      const messages: any[] = [];

      broker.reader.listen((msg) => messages.push(msg));

      await broker.start();

      await broker.writer.write({ type: "command", data: "test" } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should receive echo back from worker
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "command", data: "test" });

      await broker.stop();
    });

    it("should forward messages to leader when follower", async () => {
      const lockName = getLockName();
      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker);
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker);

      const messages1: any[] = [];
      const messages2: any[] = [];

      broker1.reader.listen((msg) => messages1.push(msg));
      broker2.reader.listen((msg) => messages2.push(msg));

      await broker1.start();

      await broker2.start();

      expect(broker1.isLeader).toBe(true);
      expect(broker2.isLeader).toBe(false);

      // Write from follower - should go to leader's worker and echo back
      await broker2.writer.write({ type: "command", data: "from-follower" } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Both should receive the echo
      expect(messages1.length).toBeGreaterThan(0);
      expect(messages2.length).toBeGreaterThan(0);
      expect(messages1[messages1.length - 1]).toEqual({ type: "command", data: "from-follower" });
      expect(messages2[messages2.length - 1]).toEqual({ type: "command", data: "from-follower" });

      await broker1.stop();
      await broker2.stop();
    });

    it("should timeout when no leader available", async () => {
      const lockName = getLockName();
      // Use a shorter timeout (100ms) for faster test execution
      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker, { timeout: 100 });
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker, { timeout: 100 });

      // Start broker1 as leader and hold the lock
      await broker1.start();

      // Mock the leader's broadcast channel to not respond
      const originalPostMessage = MockBroadcastChannel.prototype.postMessage;
      MockBroadcastChannel.prototype.postMessage = vi.fn(); // Don't broadcast

      // Start broker2 as follower
      await broker2.start();

      expect(broker2.isLeader).toBe(false);

      // Try to write from follower - should timeout since leader won't respond
      await expect(broker2.writer.write({ type: "test" } as any)).rejects.toThrow("timeout");

      // Restore
      MockBroadcastChannel.prototype.postMessage = originalPostMessage;

      await broker1.stop();
      await broker2.stop();
    });
  });

  describe("dispose", () => {
    it("should clean up resources when disposed", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);

      await broker.start();

      expect(broker.isLeader).toBe(true);

      broker.dispose();

      // Give time for cleanup
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(broker.isLeader).toBe(false);
    });
  });

  describe("onStateChange", () => {
    it("should call onStateChange when becoming leader", async () => {
      const stateChanges: boolean[] = [];
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker, {
        onStateChange: ({ isLeader }) => stateChanges.push(isLeader),
      });

      await broker.start();

      expect(broker.isLeader).toBe(true);
      expect(stateChanges).toEqual([true]);

      await broker.stop();
    });

    it("should call onStateChange when starting as follower", async () => {
      const lockName = getLockName();
      const stateChanges1: boolean[] = [];
      const stateChanges2: boolean[] = [];

      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker, {
        onStateChange: ({ isLeader }) => stateChanges1.push(isLeader),
      });
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker, {
        onStateChange: ({ isLeader }) => stateChanges2.push(isLeader),
      });

      await broker1.start();
      await broker2.start();

      expect(broker1.isLeader).toBe(true);
      expect(broker2.isLeader).toBe(false);
      expect(stateChanges1).toEqual([true]);
      expect(stateChanges2).toEqual([false]);

      await broker1.stop();
      await broker2.stop();
    });

    it("should call onStateChange when stopping as leader", async () => {
      const stateChanges: boolean[] = [];
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker, {
        onStateChange: ({ isLeader }) => stateChanges.push(isLeader),
      });

      await broker.start();
      expect(stateChanges).toEqual([true]);

      await broker.stop();
      expect(stateChanges).toEqual([true, false]);
    });

    it("should call onStateChange when follower becomes leader on failover", async () => {
      const lockName = getLockName();
      const stateChanges1: boolean[] = [];
      const stateChanges2: boolean[] = [];

      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker, {
        onStateChange: ({ isLeader }) => stateChanges1.push(isLeader),
      });
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker, {
        onStateChange: ({ isLeader }) => stateChanges2.push(isLeader),
      });

      await broker1.start();
      await broker2.start();

      expect(broker1.isLeader).toBe(true);
      expect(broker2.isLeader).toBe(false);
      expect(stateChanges1).toEqual([true]);
      expect(stateChanges2).toEqual([false]);

      // Stop leader, broker2 should become leader
      await broker1.stop();

      // Wait for broker2 to acquire the lock
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(broker2.isLeader).toBe(true);
      expect(stateChanges1).toEqual([true, false]);
      expect(stateChanges2).toEqual([false, true]);

      await broker2.stop();
    });
  });
});
