import { MultiTabWorkerBroker } from "../src/MultiTabWorkerBroker";
import { createMessageConnection, Message } from "vscode-jsonrpc";
import { InitializeRequest, ShutdownRequest, WriteFileRequest, ReadFileRequest, ExistsRequest } from "./requests";

const qs = new URLSearchParams(location.search);
const arena = qs.get("arena") || "gadget";

// Create a broker that manages the worker across tabs
// The worker creation function handles initialization
const broker = new MultiTabWorkerBroker("opfs-worker-lock", async () => {
  // Create the worker
  const worker = new Worker(new URL("./opfs-worker.ts", import.meta.url), { type: "module" });

  // Create a temporary connection just for initialization
  const { BrowserMessageReader, BrowserMessageWriter } = await import("vscode-languageserver/browser");
  const initReader = new BrowserMessageReader(worker);
  const initWriter = new BrowserMessageWriter(worker);
  const initConnection = createMessageConnection(initReader, initWriter);

  // Start listening
  initConnection.listen();

  try {
    // Initialize the worker with a reasonable timeout
    await initConnection.sendRequest(InitializeRequest, { arena });

    // Give a moment for any pending messages to be processed
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Dispose the temporary connection (but keep the worker running)
    initConnection.dispose();
  } catch (error) {
    // If initialization fails, clean up the worker
    worker.terminate();
    throw error;
  }

  return worker;
}, { debug: true });

// Create a connection from the broker
const brokerConnection = broker.createConnection();

// Create JSON-RPC connection using the connection's reader and writer
const connection = createMessageConnection(brokerConnection.reader, brokerConnection.writer);

let started = false;

// Expose test surface
declare global {
  interface Window {
    thumbdriveTest: {
      start: () => Promise<void>;
      shutdown: () => Promise<void>;
      isLeader: () => boolean;
      writeFile: (p: string, s: string) => Promise<void>;
      readFile: (p: string) => Promise<string>;
      exists: (p: string) => Promise<boolean>;
    };
  }
}

window.thumbdriveTest = {
  async start() {
    if (!started) {
      // Start the broker (this will create and initialize the worker if we become leader)
      await broker.start();

      // Start listening for JSON-RPC messages
      connection.listen();

      started = true;
    }
  },
  async shutdown() {
    if (started) {
      await connection.sendRequest(ShutdownRequest);
      await broker.stop();
      connection.dispose();
      brokerConnection.dispose();
      started = false;
    }
  },
  isLeader: () => broker.isLeader,
  async writeFile(p: string, s: string) {
    if (!started) throw new Error("Not started - call start() first");
    await connection.sendRequest(WriteFileRequest, { path: p, data: s });
  },
  async readFile(p: string) {
    if (!started) throw new Error("Not started - call start() first");
    const result = await connection.sendRequest(ReadFileRequest, { path: p });
    return result.data;
  },
  async exists(p: string) {
    if (!started) throw new Error("Not started - call start() first");
    const result = await connection.sendRequest(ExistsRequest, { path: p });
    return result.exists;
  },
};
