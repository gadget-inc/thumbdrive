import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MultiTabWorkerBroker } from "../src/MultiTabWorkerBroker";
import { MockLockManager, MockBroadcastChannel } from "./mocks";

describe("MultiTabWorkerBroker", () => {
  let makeWorker: () => Worker;
  let mockLocks: MockLockManager;
  let workers: Worker[] = [];

  beforeEach(() => {
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

    MockBroadcastChannel.reset();
    mockLocks.reset();
    vi.unstubAllGlobals();
  });

  it("should create a broker with reader and writer", () => {
    const broker = new MultiTabWorkerBroker("test-lock", makeWorker);

    expect(broker.reader).toBeDefined();
    expect(broker.writer).toBeDefined();
    expect(broker.getIsLeader()).toBe(false);
  });

  describe("lifecycle", () => {
    it("should start and acquire leadership", async () => {
      const broker = new MultiTabWorkerBroker("test-lock", makeWorker);

      await broker.start();

      // Give a moment for lock acquisition
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(broker.getIsLeader()).toBe(true);

      await broker.stop();
    });

    it("should not start twice", async () => {
      const broker = new MultiTabWorkerBroker("test-lock", makeWorker);
      const makeWorkerSpy = vi.fn(makeWorker);
      const broker2 = new MultiTabWorkerBroker("test-lock-2", makeWorkerSpy);

      await broker2.start();
      await broker2.start(); // Second call should be no-op

      expect(makeWorkerSpy).toHaveBeenCalledTimes(1);

      await broker.stop();
      await broker2.stop();
    });

    it("should stop cleanly", async () => {
      const broker = new MultiTabWorkerBroker("test-lock", makeWorker);

      await broker.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(broker.getIsLeader()).toBe(true);

      await broker.stop();

      expect(broker.getIsLeader()).toBe(false);
    });

    it("should not fail when stopping before starting", async () => {
      const broker = new MultiTabWorkerBroker("test-lock", makeWorker);
      await expect(broker.stop()).resolves.toBeUndefined();
    });
  });

  describe("reader", () => {
    it("should receive messages from worker when leader", async () => {
      const broker = new MultiTabWorkerBroker("test-lock", makeWorker);
      const messages: any[] = [];

      broker.reader.listen((msg) => messages.push(msg));

      await broker.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Write a message - the test worker will echo it back
      await broker.writer.write({ type: "test", data: "hello" });

      // Wait for the echo
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "test", data: "hello" });

      await broker.stop();
    });

    it("should forward worker messages to other tabs via broadcast", async () => {
      const broker1 = new MultiTabWorkerBroker("test-lock", makeWorker);
      const broker2 = new MultiTabWorkerBroker("test-lock", makeWorker);

      const messages1: any[] = [];
      const messages2: any[] = [];

      broker1.reader.listen((msg) => messages1.push(msg));
      broker2.reader.listen((msg) => messages2.push(msg));

      // Start broker1 (becomes leader)
      await broker1.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Start broker2 (becomes follower)
      const broker2Start = broker2.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(broker1.getIsLeader()).toBe(true);
      expect(broker2.getIsLeader()).toBe(false);

      // Send a message from leader - worker will echo it back
      await broker1.writer.write({ type: "test", data: "broadcast" });

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
      const broker = new MultiTabWorkerBroker("test-lock", makeWorker);
      const messages1: any[] = [];
      const messages2: any[] = [];

      broker.reader.listen((msg) => messages1.push(msg));
      broker.reader.listen((msg) => messages2.push(msg));

      await broker.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      await broker.writer.write({ type: "test" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages1).toHaveLength(1);
      expect(messages2).toHaveLength(1);

      await broker.stop();
    });

    it("should allow listeners to be disposed", async () => {
      const broker = new MultiTabWorkerBroker("test-lock", makeWorker);
      const messages: any[] = [];

      const disposable = broker.reader.listen((msg) => messages.push(msg));

      await broker.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      await broker.writer.write({ type: "test1" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      disposable.dispose();

      await broker.writer.write({ type: "test2" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("test1");

      await broker.stop();
    });
  });

  describe("writer", () => {
    it("should send messages to worker when leader", async () => {
      const broker = new MultiTabWorkerBroker<any>("test-lock", makeWorker);
      const messages: any[] = [];

      broker.reader.listen((msg) => messages.push(msg));

      await broker.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      await broker.writer.write({ type: "command", data: "test" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should receive echo back from worker
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "command", data: "test" });

      await broker.stop();
    });

    it("should forward messages to leader when follower", async () => {
      const broker1 = new MultiTabWorkerBroker<any>("test-lock", makeWorker);
      const broker2 = new MultiTabWorkerBroker<any>("test-lock", makeWorker);

      const messages1: any[] = [];
      const messages2: any[] = [];

      broker1.reader.listen((msg) => messages1.push(msg));
      broker2.reader.listen((msg) => messages2.push(msg));

      await broker1.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const broker2Start = broker2.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(broker1.getIsLeader()).toBe(true);
      expect(broker2.getIsLeader()).toBe(false);

      // Write from follower - should go to leader's worker and echo back
      await broker2.writer.write({ type: "command", data: "from-follower" });
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
      // Use a shorter timeout (100ms) for faster test execution
      const broker1 = new MultiTabWorkerBroker<any>("test-lock", makeWorker, { timeout: 100 });
      const broker2 = new MultiTabWorkerBroker<any>("test-lock", makeWorker, { timeout: 100 });

      // Start broker1 as leader and hold the lock
      await broker1.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Mock the leader's broadcast channel to not respond
      const originalPostMessage = MockBroadcastChannel.prototype.postMessage;
      MockBroadcastChannel.prototype.postMessage = vi.fn(); // Don't broadcast

      // Start broker2 as follower
      const broker2Start = broker2.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(broker2.getIsLeader()).toBe(false);

      // Try to write from follower - should timeout since leader won't respond
      await expect(broker2.writer.write({ type: "test" })).rejects.toThrow("timeout");

      // Restore
      MockBroadcastChannel.prototype.postMessage = originalPostMessage;

      await broker1.stop();
      await broker2.stop();
    });
  });

  describe("dispose", () => {
    it("should clean up resources when disposed", async () => {
      const broker = new MultiTabWorkerBroker("test-lock", makeWorker);

      await broker.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(broker.getIsLeader()).toBe(true);

      broker.dispose();

      // Give time for cleanup
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(broker.getIsLeader()).toBe(false);
    });
  });
});
