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

  it("should create a broker and allow creating connections", () => {
    const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);

    expect(broker.isLeader).toBe(false);

    const connection = broker.createConnection();
    expect(connection.reader).toBeDefined();
    expect(connection.writer).toBeDefined();
    expect(connection.dispose).toBeDefined();

    connection.dispose();
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

    it("should successfully teardown a worker and restart with the same lock name as leader", async () => {
      const lockName = getLockName();

      // Start first broker as leader
      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker);
      await broker1.start();
      expect(broker1.isLeader).toBe(true);

      // Verify it can send and receive messages
      const messages1: any[] = [];
      const conn1 = broker1.createConnection();
      conn1.reader.listen((msg) => messages1.push(msg));
      await conn1.writer.write({ type: "test", data: "first-worker" } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(messages1).toHaveLength(1);
      expect(messages1[0]).toEqual({ type: "test", data: "first-worker" });

      // Teardown the broker
      await broker1.stop();
      expect(broker1.isLeader).toBe(false);

      // Wait a bit to ensure cleanup is complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Create and start a new broker with the same lock name
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker);
      await broker2.start();

      // Should become leader
      expect(broker2.isLeader).toBe(true);

      // Verify the new broker can send and receive messages
      const messages2: any[] = [];
      const conn2 = broker2.createConnection();
      conn2.reader.listen((msg) => messages2.push(msg));
      await conn2.writer.write({ type: "test", data: "second-worker" } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(messages2).toHaveLength(1);
      expect(messages2[0]).toEqual({ type: "test", data: "second-worker" });

      await broker2.stop();
    });

    it("should teardown and restart multiple times with the same lock name", async () => {
      const lockName = getLockName();

      for (let i = 0; i < 3; i++) {
        const broker = new MultiTabWorkerBroker(lockName, makeWorker);
        await broker.start();

        // Should become leader each time
        expect(broker.isLeader).toBe(true);

        // Verify it can communicate
        const messages: any[] = [];
        const conn = broker.createConnection();
        conn.reader.listen((msg) => messages.push(msg));
        await conn.writer.write({
          jsonrpc: "2.0",
          id: 1,
          method: "echo",
          params: { iteration: i },
        } as any);
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          id: 1,
          result: { iteration: i },
        });

        // Teardown
        await broker.stop();
        expect(broker.isLeader).toBe(false);

        // Wait between iterations
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    });

    it("should handle teardown and restart while a follower is waiting", async () => {
      const lockName = getLockName();

      // Start first broker as leader
      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker);
      await broker1.start();
      expect(broker1.isLeader).toBe(true);

      // Start second broker as follower
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker);
      await broker2.start();
      expect(broker2.isLeader).toBe(false);

      // Setup listener on follower
      const followerMessages: any[] = [];
      const conn2 = broker2.createConnection();
      conn2.reader.listen((msg) => followerMessages.push(msg));

      // Teardown the leader
      await broker1.stop();

      // Wait for follower to become leader
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(broker2.isLeader).toBe(true);

      // Verify new leader can communicate
      await conn2.writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "echo",
        params: { promoted: true },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(followerMessages).toContainEqual(expect.objectContaining({ id: 1, result: { promoted: true } }));

      // Teardown the promoted leader
      await broker2.stop();
      expect(broker2.isLeader).toBe(false);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Start a new broker with the same lock name
      const broker3 = new MultiTabWorkerBroker(lockName, makeWorker);
      await broker3.start();
      expect(broker3.isLeader).toBe(true);

      // Verify it works
      const messages3: any[] = [];
      const conn3 = broker3.createConnection();
      conn3.reader.listen((msg) => messages3.push(msg));
      await conn3.writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "echo",
        params: { fresh: true },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages3).toContainEqual(expect.objectContaining({ id: 1, result: { fresh: true } }));

      await broker3.stop();
    });

    it("should handle rapid start/stop cycles without errors", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);

      // Rapidly start and stop multiple times with minimal delays
      await broker.start();
      expect(broker.isLeader).toBe(true);

      await broker.stop();
      expect(broker.isLeader).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 10));

      await broker.start();
      expect(broker.isLeader).toBe(true);

      await broker.stop();
      expect(broker.isLeader).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 10));

      await broker.start();
      expect(broker.isLeader).toBe(true);

      await broker.stop();
      expect(broker.isLeader).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // One final cycle to ensure it still works
      await broker.start();
      expect(broker.isLeader).toBe(true);

      // Give the worker a moment to fully initialize after rapid cycling
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Verify it can still send and receive messages after rapid cycling
      const messages: any[] = [];
      const conn = broker.createConnection();
      conn.reader.listen((msg) => messages.push(msg));
      await conn.writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "echo",
        params: { test: "rapid-cycles" },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ id: 1, result: { test: "rapid-cycles" } });

      await broker.stop();
      expect(broker.isLeader).toBe(false);
    });

    it("should allow a new broker to immediately acquire the lock after stop", async () => {
      const lockName = getLockName();

      // Start first broker
      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker);
      await broker1.start();
      expect(broker1.isLeader).toBe(true);

      // Verify first broker works
      const messages1: any[] = [];
      const conn1 = broker1.createConnection();
      conn1.reader.listen((msg) => messages1.push(msg));
      await conn1.writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "echo",
        params: { broker: "first" },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(messages1).toHaveLength(1);
      expect(messages1[0]).toMatchObject({ id: 1, result: { broker: "first" } });

      // Stop first broker
      await broker1.stop();
      expect(broker1.isLeader).toBe(false);

      // Immediately start a new broker with the same lock name
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker);
      await broker2.start();

      // Should immediately become leader since the lock was released
      expect(broker2.isLeader).toBe(true);

      // Verify second broker works
      const messages2: any[] = [];
      const conn2 = broker2.createConnection();
      conn2.reader.listen((msg) => messages2.push(msg));
      await conn2.writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "echo",
        params: { broker: "second" },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(messages2).toHaveLength(1);
      expect(messages2[0]).toMatchObject({ id: 1, result: { broker: "second" } });

      await broker2.stop();
    });
  });

  describe("reader", () => {
    it("should receive messages from worker when leader", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);
      const messages: any[] = [];

      const conn = broker.createConnection();
      conn.reader.listen((msg) => messages.push(msg));

      await broker.start();

      // Write a message - the test worker will echo it back
      await conn.writer.write({ type: "test", data: "hello" } as any);

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

      const conn1 = broker1.createConnection();
      const conn2 = broker2.createConnection();
      conn1.reader.listen((msg) => messages1.push(msg));
      conn2.reader.listen((msg) => messages2.push(msg));

      // Start broker1 (becomes leader)
      await broker1.start();

      // Start broker2 (becomes follower)
      await broker2.start();

      expect(broker1.isLeader).toBe(true);
      expect(broker2.isLeader).toBe(false);

      // Send a message from leader - worker will echo it back
      await conn1.writer.write({ type: "test", data: "broadcast" } as any);

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

      const conn = broker.createConnection();
      conn.reader.listen((msg) => messages1.push(msg));
      conn.reader.listen((msg) => messages2.push(msg));

      await broker.start();

      await conn.writer.write({ type: "test" } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages1).toHaveLength(1);
      expect(messages2).toHaveLength(1);

      await broker.stop();
    });

    it("should allow listeners to be disposed", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);
      const messages: any[] = [];

      const conn = broker.createConnection();
      const disposable = conn.reader.listen((msg) => messages.push(msg));

      await broker.start();

      await conn.writer.write({ type: "test1" } as any);
      await new Promise((resolve) => setTimeout(resolve, 50));

      disposable.dispose();

      await conn.writer.write({ type: "test2" } as any);
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

      const conn = broker.createConnection();
      conn.reader.listen((msg) => messages.push(msg));

      await broker.start();

      await conn.writer.write({ type: "command", data: "test" } as any);
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

      const conn1 = broker1.createConnection();
      const conn2 = broker2.createConnection();
      conn1.reader.listen((msg) => messages1.push(msg));
      conn2.reader.listen((msg) => messages2.push(msg));

      await broker1.start();

      await broker2.start();

      expect(broker1.isLeader).toBe(true);
      expect(broker2.isLeader).toBe(false);

      // Write from follower - should go to leader's worker and echo back
      await conn2.writer.write({ type: "command", data: "from-follower" } as any);
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

      const conn2 = broker2.createConnection();

      // Try to write from follower - should timeout since leader won't respond
      await expect(conn2.writer.write({ type: "test" } as any)).rejects.toThrow("timeout");

      // Restore
      MockBroadcastChannel.prototype.postMessage = originalPostMessage;

      await broker1.stop();
      await broker2.stop();
    });

    it("should handle overlapping JSONRPC IDs from different followers correctly", async () => {
      const lockName = getLockName();
      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker);
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker);
      const broker3 = new MultiTabWorkerBroker(lockName, makeWorker);

      const messages1: any[] = [];
      const messages2: any[] = [];
      const messages3: any[] = [];

      const conn1 = broker1.createConnection();
      const conn2 = broker2.createConnection();
      const conn3 = broker3.createConnection();
      conn1.reader.listen((msg) => messages1.push(msg));
      conn2.reader.listen((msg) => messages2.push(msg));
      conn3.reader.listen((msg) => messages3.push(msg));

      await broker1.start();
      await broker2.start();
      await broker3.start();

      expect(broker1.isLeader).toBe(true);
      expect(broker2.isLeader).toBe(false);
      expect(broker3.isLeader).toBe(false);

      // Both followers send JSONRPC requests with id: 1, but different parameters
      const promise2 = conn2.writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "getBrokerId",
        params: { brokerId: "broker2" },
      } as any);

      const promise3 = conn3.writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "getBrokerId",
        params: { brokerId: "broker3" },
      } as any);

      // Wait for both to complete
      await Promise.all([promise2, promise3]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Leader should NOT have received these responses (they're for followers)
      expect(messages1.length).toBe(0);

      // Broker2 should have received only its own response
      expect(messages2.length).toBe(1);
      expect(messages2[0]).toMatchObject({
        id: 1,
        result: "response-for-broker2",
      });

      // Broker3 should have received only its own response
      expect(messages3.length).toBe(1);
      expect(messages3[0]).toMatchObject({
        id: 1,
        result: "response-for-broker3",
      });

      await broker1.stop();
      await broker2.stop();
      await broker3.stop();
    });

    it("should handle different JSONRPC methods correctly", async () => {
      const lockName = getLockName();
      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker);
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker);

      const messages1: any[] = [];
      const messages2: any[] = [];

      const conn1 = broker1.createConnection();
      const conn2 = broker2.createConnection();
      conn1.reader.listen((msg) => messages1.push(msg));
      conn2.reader.listen((msg) => messages2.push(msg));

      await broker1.start();
      await broker2.start();

      // Leader sends an "add" request
      await conn1.writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "add",
        params: { a: 5, b: 3 },
      } as any);

      // Follower sends an "echo" request with the same ID
      await conn2.writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "echo",
        params: { text: "hello from follower" },
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Leader should get result: 8
      expect(messages1).toContainEqual(
        expect.objectContaining({
          id: 1,
          result: 8,
        })
      );

      // Follower should get echoed params
      expect(messages2).toContainEqual(
        expect.objectContaining({
          id: 1,
          result: { text: "hello from follower" },
        })
      );

      await broker1.stop();
      await broker2.stop();
    });

    it("should handle JSONRPC notifications (no id) correctly", async () => {
      const lockName = getLockName();
      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker);
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker);

      const messages1: any[] = [];
      const messages2: any[] = [];

      const conn1 = broker1.createConnection();
      const conn2 = broker2.createConnection();
      conn1.reader.listen((msg) => messages1.push(msg));
      conn2.reader.listen((msg) => messages2.push(msg));

      await broker1.start();
      await broker2.start();

      // Send a notification (no id) from follower
      await conn2.writer.write({
        jsonrpc: "2.0",
        method: "someNotification",
        params: { data: "notification" },
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Both should receive the notification since it has no ID
      expect(messages1.length).toBeGreaterThan(0);
      expect(messages2.length).toBeGreaterThan(0);

      await broker1.stop();
      await broker2.stop();
    });

    it("should handle numeric JSONRPC IDs correctly", async () => {
      const lockName = getLockName();
      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker);
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker);

      const messages1: any[] = [];
      const messages2: any[] = [];

      const conn1 = broker1.createConnection();
      const conn2 = broker2.createConnection();
      conn1.reader.listen((msg) => messages1.push(msg));
      conn2.reader.listen((msg) => messages2.push(msg));

      await broker1.start();
      await broker2.start();

      // Leader sends request with numeric ID
      await conn1.writer.write({
        jsonrpc: "2.0",
        id: 42,
        method: "add",
        params: { a: 10, b: 20 },
      } as any);

      // Follower sends request with same numeric ID but different method
      await conn2.writer.write({
        jsonrpc: "2.0",
        id: 42,
        method: "echo",
        params: { value: "test" },
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Leader should have received result: 30
      expect(messages1).toContainEqual(
        expect.objectContaining({
          id: 42,
          result: 30,
        })
      );

      // Follower should have received echoed value
      expect(messages2).toContainEqual(
        expect.objectContaining({
          id: 42,
          result: { value: "test" },
        })
      );

      // Each should only have their own response
      expect(messages1.length).toBe(1);
      expect(messages2.length).toBe(1);

      await broker1.stop();
      await broker2.stop();
    });

    it("should handle sequential requests with correct ordering", async () => {
      const lockName = getLockName();
      const broker1 = new MultiTabWorkerBroker(lockName, makeWorker);
      const broker2 = new MultiTabWorkerBroker(lockName, makeWorker);

      const messages2: any[] = [];
      const conn2 = broker2.createConnection();
      conn2.reader.listen((msg) => messages2.push(msg));

      await broker1.start();
      await broker2.start();

      // Follower sends multiple sequential requests
      await conn2.writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "echo",
        params: { seq: 1 },
      } as any);

      await conn2.writer.write({
        jsonrpc: "2.0",
        id: 2,
        method: "echo",
        params: { seq: 2 },
      } as any);

      await conn2.writer.write({
        jsonrpc: "2.0",
        id: 3,
        method: "echo",
        params: { seq: 3 },
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have received responses in correct order
      expect(messages2.length).toBe(3);
      expect(messages2[0]).toMatchObject({ id: 1, result: { seq: 1 } });
      expect(messages2[1]).toMatchObject({ id: 2, result: { seq: 2 } });
      expect(messages2[2]).toMatchObject({ id: 3, result: { seq: 3 } });

      await broker1.stop();
      await broker2.stop();
    });

    it("should work after failover even with complex worker initialization", async () => {
      const lockName = getLockName();

      // Create a worker factory that simulates the testapp pattern
      // where we initialize the worker with a temporary connection
      const makeComplexWorker = async () => {
        const worker = new Worker(new URL("./test-worker.ts", import.meta.url), { type: "module" });

        // Simulate initialization with a message (like the Initialize RPC)
        await new Promise<void>((resolve) => {
          const handler = (event: MessageEvent) => {
            if (event.data && typeof event.data === "object" && event.data.id === "init") {
              worker.removeEventListener("message", handler);
              resolve();
            }
          };
          worker.addEventListener("message", handler);
          worker.postMessage({ jsonrpc: "2.0", id: "init", method: "echo", params: { initialized: true } });
        });

        return worker;
      };

      const broker1 = new MultiTabWorkerBroker(lockName, makeComplexWorker);
      const broker2 = new MultiTabWorkerBroker(lockName, makeComplexWorker);

      const messages1: any[] = [];
      const messages2: any[] = [];

      const conn1 = broker1.createConnection();
      const conn2 = broker2.createConnection();
      conn1.reader.listen((msg) => messages1.push(msg));
      conn2.reader.listen((msg) => messages2.push(msg));

      // Start both brokers
      await broker1.start();
      await broker2.start();

      expect(broker1.isLeader).toBe(true);
      expect(broker2.isLeader).toBe(false);

      // Follower sends a request
      await conn2.writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "echo",
        params: { before: "failover" },
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should work
      expect(messages2.length).toBe(1);
      expect(messages2[0]).toMatchObject({ id: 1, result: { before: "failover" } });

      // Stop leader to trigger failover
      await broker1.stop();

      // Wait for failover
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(broker2.isLeader).toBe(true);

      // New leader should be able to process requests
      await conn2.writer.write({
        jsonrpc: "2.0",
        id: 2,
        method: "echo",
        params: { after: "failover" },
      } as any);

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have received the response
      expect(messages2.length).toBe(2);
      expect(messages2[1]).toMatchObject({ id: 2, result: { after: "failover" } });

      await broker2.stop();
    });

    it("should deliver early worker responses posted before connection.listen attaches", async () => {
      const lockName = getLockName();

      // Worker that immediately responds to an initialize request posted by makeWorker
      const makeBootWorker = async () => {
        const worker = new Worker(new URL("./test-worker.ts", import.meta.url), { type: "module" });
        // Simulate app pattern: send initialize before creating connection/listeners
        worker.postMessage({ jsonrpc: "2.0", id: 1, method: "echo", params: { init: true } });
        return worker;
      };

      const broker = new MultiTabWorkerBroker(lockName, makeBootWorker);
      const messages: any[] = [];

      await broker.start();
      // Attach listener after start; buffered response should flush
      const conn = broker.createConnection();
      conn.reader.listen((msg) => messages.push(msg));

      // Give a moment for flush
      await new Promise((r) => setTimeout(r, 50));

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0]).toMatchObject({ id: 1, result: { init: true } });

      await broker.stop();
    });

    it("should survive failover when worker posts initialize before listeners attach", async () => {
      const lockName = getLockName();

      const makeBootWorker = async () => {
        const worker = new Worker(new URL("./test-worker.ts", import.meta.url), { type: "module" });
        // Post an initialize-like request that will elicit an early response (id 1)
        worker.postMessage({ jsonrpc: "2.0", id: 1, method: "echo", params: { initialized: true } });
        return worker;
      };

      const leader = new MultiTabWorkerBroker(lockName, makeBootWorker);
      const follower = new MultiTabWorkerBroker(lockName, makeBootWorker);

      const followerMessages: any[] = [];

      await leader.start();
      await follower.start();

      expect(leader.isLeader).toBe(true);
      expect(follower.isLeader).toBe(false);

      const followerConn = follower.createConnection();
      followerConn.reader.listen((m) => followerMessages.push(m));

      // Follower sends a request prior to failover (id 2)
      await followerConn.writer.write({ jsonrpc: "2.0", id: 2, method: "echo", params: { before: true } } as any);
      await new Promise((r) => setTimeout(r, 50));
      expect(followerMessages).toContainEqual(expect.objectContaining({ id: 2 }));

      // Stop leader to trigger failover
      await leader.stop();
      await new Promise((r) => setTimeout(r, 100));
      expect(follower.isLeader).toBe(true);

      // New leader posts more requests; should get responses despite early unscoped id=1 response
      await followerConn.writer.write({ jsonrpc: "2.0", id: 3, method: "echo", params: { after: 1 } } as any);
      await followerConn.writer.write({ jsonrpc: "2.0", id: 4, method: "echo", params: { after: 2 } } as any);
      await new Promise((r) => setTimeout(r, 100));

      expect(followerMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 3, result: { after: 1 } }),
          expect.objectContaining({ id: 4, result: { after: 2 } }),
        ])
      );

      await follower.stop();
    });

    it("should work with LSP-like init + initialized sequencing across failover", async () => {
      const lockName = getLockName();

      const makeLspWorker = async () => {
        const worker = new Worker(new URL("./test-worker-lsp-like.ts", import.meta.url), { type: "module" });
        // Temp init connection like app does
        const { BrowserMessageReader, BrowserMessageWriter } = await import("vscode-languageserver/browser");
        const { createMessageConnection } = await import("vscode-jsonrpc");
        const initReader = new BrowserMessageReader(worker);
        const initWriter = new BrowserMessageWriter(worker);
        const initConn = createMessageConnection(initReader as any, initWriter as any);
        initConn.listen();
        await initConn.sendRequest({ method: "initialize" } as any, { processId: null, rootUri: null, capabilities: {} });
        await initConn.sendNotification({ method: "initialized" } as any, {});
        initReader.dispose();
        initWriter.dispose();
        return worker;
      };

      const leader = new MultiTabWorkerBroker(lockName, makeLspWorker);
      const follower = new MultiTabWorkerBroker(lockName, makeLspWorker);

      const followerMsgs: any[] = [];
      const followerConn = follower.createConnection();
      followerConn.reader.listen((m) => followerMsgs.push(m));

      await leader.start();
      await follower.start();

      // Follower should be able to send echo after init/initialized
      await followerConn.writer.write({ jsonrpc: "2.0", id: 1, method: "echo", params: { ok: true } } as any);
      await new Promise((r) => setTimeout(r, 50));
      expect(followerMsgs).toContainEqual(expect.objectContaining({ id: 1, result: { ok: true } }));

      // Trigger failover
      await leader.stop();
      await new Promise((r) => setTimeout(r, 150));
      expect(follower.isLeader).toBe(true);

      // New leader can still send and receive
      await followerConn.writer.write({ jsonrpc: "2.0", id: 2, method: "add", params: { a: 2, b: 3 } } as any);
      await new Promise((r) => setTimeout(r, 50));
      expect(followerMsgs).toContainEqual(expect.objectContaining({ id: 2, result: 5 }));

      await follower.stop();
    });

    it("should deliver follower requests sent during leader boot (worker not ready yet)", async () => {
      const lockName = getLockName();

      // Make a worker that starts responding after a delay to simulate boot time
      const makeSlowWorker = async () => {
        const worker = new Worker(new URL("./test-worker.ts", import.meta.url), { type: "module" });
        // Simulate internal boot by delaying first response in the worker side? Our test worker
        // echoes immediately; we simulate boot at the broker by queueing before worker ready.
        return worker;
      };

      const leader = new MultiTabWorkerBroker(lockName, async () => {
        // Delay creating the worker to widen the window for queued requests
        await new Promise((r) => setTimeout(r, 100));
        return await makeSlowWorker();
      });
      const follower = new MultiTabWorkerBroker(lockName, makeSlowWorker);

      const followerMsgs: any[] = [];
      const followerConn = follower.createConnection();
      followerConn.reader.listen((m) => followerMsgs.push(m));

      // Start leader
      await leader.start();
      expect(leader.isLeader).toBe(true);

      // Start follower and immediately send requests while leader is booting a new worker (simulate failover)
      await follower.start();
      expect(follower.isLeader).toBe(false);

      // Force leader to release so follower acquires lock and begins booting
      const stopPromise = leader.stop();
      // Small delay to ensure follower's lock wait proceeds
      await new Promise((r) => setTimeout(r, 10));
      // Now, before new worker is ready, send a couple of requests
      const p1 = followerConn.writer.write({ jsonrpc: "2.0", id: 1, method: "echo", params: { during: 1 } } as any);
      const p2 = followerConn.writer.write({ jsonrpc: "2.0", id: 2, method: "echo", params: { during: 2 } } as any);
      await stopPromise;

      // Give time for follower to acquire lock and broker to create worker, then for queue to drain
      await Promise.all([p1, p2]);
      await new Promise((r) => setTimeout(r, 200));

      expect(follower.isLeader).toBe(true);
      // Both responses should arrive even though they were sent while leader was booting
      expect(followerMsgs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 1, result: { during: 1 } }),
          expect.objectContaining({ id: 2, result: { during: 2 } }),
        ])
      );

      await follower.stop();
    });
  });

  describe("dispose", () => {
    it("should clean up resources when disposed", async () => {
      const broker = new MultiTabWorkerBroker(getLockName(), makeWorker);

      await broker.start();

      expect(broker.isLeader).toBe(true);

      await broker.stop();

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
