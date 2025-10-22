import { MultiTabWorkerBroker } from "../src/MultiTabWorkerBroker";
import {
  createMessageConnection,
  MessageReader,
  MessageWriter,
  DataCallback,
  Message,
  Disposable,
  Event,
  Emitter,
  PartialMessageInfo,
} from "vscode-jsonrpc";
import { InitializeRequest, ShutdownRequest, WriteFileRequest, ReadFileRequest, ExistsRequest } from "./requests";

const qs = new URLSearchParams(location.search);
const arena = qs.get("arena") || "gadget";

// Create custom MessageReader that works with the broker
class BrokerMessageReader implements MessageReader {
  private errorEmitter = new Emitter<Error>();
  private closeEmitter = new Emitter<void>();
  private partialMessageEmitter = new Emitter<PartialMessageInfo>();

  onError: Event<Error> = this.errorEmitter.event;
  onClose: Event<void> = this.closeEmitter.event;
  onPartialMessage: Event<PartialMessageInfo> = this.partialMessageEmitter.event;

  constructor(private broker: MultiTabWorkerBroker<Message>) {
    // Forward broker errors to our error emitter
    this.broker.reader.onError((error) => {
      this.errorEmitter.fire(error);
    });
    // Forward broker close to our close emitter
    this.broker.reader.onClose(() => {
      this.closeEmitter.fire();
    });
  }

  listen(callback: DataCallback): Disposable {
    return this.broker.reader.listen((message) => {
      callback(message);
    });
  }

  dispose(): void {
    this.errorEmitter.dispose();
    this.closeEmitter.dispose();
    this.partialMessageEmitter.dispose();
    this.broker.reader.dispose();
  }
}

// Create custom MessageWriter that works with the broker
class BrokerMessageWriter implements MessageWriter {
  private errorEmitter = new Emitter<[Error, Message | undefined, number | undefined]>();
  private closeEmitter = new Emitter<void>();

  onError: Event<[Error, Message | undefined, number | undefined]> = this.errorEmitter.event;
  onClose: Event<void> = this.closeEmitter.event;

  constructor(private broker: MultiTabWorkerBroker<Message>) {
    // Forward broker errors to our error emitter
    this.broker.writer.onError((error) => {
      this.errorEmitter.fire([error, undefined, undefined]);
    });
    // Forward broker close to our close emitter
    this.broker.writer.onClose(() => {
      this.closeEmitter.fire();
    });
  }

  async write(message: Message): Promise<void> {
    try {
      await this.broker.writer.write(message);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.errorEmitter.fire([err, message, undefined]);
      throw err;
    }
  }

  dispose(): void {
    this.errorEmitter.dispose();
    this.closeEmitter.dispose();
    this.broker.writer.dispose();
  }

  end(): void {
    // Not needed for broker communication
  }
}

// Create a broker that manages the worker across tabs
// The worker creation function handles initialization
const broker = new MultiTabWorkerBroker<Message>("opfs-worker-lock", async () => {
  // Create the worker
  const worker = new Worker(new URL("./opfs-worker.ts", import.meta.url), { type: "module" });

  // Create a temporary connection just for initialization
  const { BrowserMessageReader, BrowserMessageWriter } = await import("vscode-languageserver/browser");
  const initReader = new BrowserMessageReader(worker);
  const initWriter = new BrowserMessageWriter(worker);
  const initConnection = createMessageConnection(initReader, initWriter);

  // Start listening
  initConnection.listen();

  // Initialize the worker
  await initConnection.sendRequest(InitializeRequest, { arena });

  // Dispose the temporary connection (but keep the worker running)
  initConnection.dispose();

  return worker;
});

// Create JSON-RPC connection
const reader = new BrokerMessageReader(broker);
const writer = new BrokerMessageWriter(broker);
const connection = createMessageConnection(reader, writer);

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
      started = false;
    }
  },
  isLeader: () => broker.getIsLeader(),
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
