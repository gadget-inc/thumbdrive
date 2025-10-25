# thumbdrive

Browser infrastructure for reducing memory usage in web-based code editors and language servers.

## Problem

Browser tabs crash from memory pressure when running TypeScript language servers that hold large codebases (including `.d.ts` files) in memory. Browsers kill tabs based on total memory usage across all open tabs, making multi-tab workflows particularly problematic.

## Solution

Two primitives that work together to minimize memory usage:

### `SyncOPFSFileSystem`

A synchronous virtual filesystem backed by OPFS (Origin Private File System) that stores files on disk instead of in memory.

**Why it's needed:** TypeScript's language server assumes fully synchronous filesystem access (`fs.readFileSync`). OPFS only provides sync access through `FileSystemSyncAccessHandle`, which requires async file handle acquisition. This VFS solves the problem by maintaining a single pre-opened binary arena file (`arena.bin`) with an in-memory index of file locations, providing sync read/write to any file without opening handles.

```typescript
import { SyncOPFSFileSystem } from "thumbdrive";

const fs = new SyncOPFSFileSystem("my-project");
await fs.init();

// Fully synchronous filesystem operations backed by OPFS
fs.writeFileSync("/src/index.ts", "export const x = 1;");
const content = fs.readFileSync("/src/index.ts");
fs.existsSync("/src/index.ts"); // true
```

### `MultiTabWorkerBroker`

Coordinates multiple browser tabs to share a single web worker, dramatically reducing per-tab memory overhead.

**Why it's needed:** Each TypeScript LSP worker consumes ~1GB+ of memory for type information and parsed files. With multiple tabs, this multiplies quickly. The broker uses the Web Locks API to elect a leader tab that runs the worker, while follower tabs proxy messages via BroadcastChannel. When the leader closes, a follower automatically takes over and starts a new worker.

```typescript
import { MultiTabWorkerBroker } from "thumbdrive";
import { createMessageConnection } from "vscode-jsonrpc/browser";

const broker = new MultiTabWorkerBroker("typescript-lsp-lock", () => new Worker(new URL("./lsp-worker.js", import.meta.url)));

await broker.start();

// Create a JSON-RPC connection to the worker (or proxied through leader tab)
const { reader, writer } = broker.createConnection();
const connection = createMessageConnection(reader, writer);

// All tabs communicate with the same underlying worker
connection.sendRequest("initialize", { rootUri: "/project" });
```

## Installation

```bash
npm install thumbdrive
```

## Requirements

- Modern browser with OPFS sync access support (Chrome 102+, Edge 102+)
- Web Workers
- SharedArrayBuffer support (requires appropriate CORS headers for multi-tab coordination)

## License

MIT
