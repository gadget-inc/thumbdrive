# thumbdrive

Browser infrastructure for reducing memory usage in web-based code editors and language servers.

## Problem

If you want to store a lot of files client side, say to power a language service or SQLite database or similar, storing all your files in memory occupies a lot of memory! We have disks for just this purpose and [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) is a helpful Web API for doing just that.

If you have a synchronous client side use case however, like say a TypeScript language service or a VFS for SQLite, OPFS doesn't quite fit the bill, as it's access patterns are all async. You can do synchronous reads and writes once you have a file handle open, but you can't open new files synchronously.

Worse yet, once you have that file handle open in one tab, you can't open it in any other tabs due to OPFS' locking semantics!

## Solution

Two primitives that work together to allow sync FS usage among many tabs:

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

Coordinates multiple browser tabs to share a single web worker that owns the FS. Instead of each tab opening its own filesystem (and using the hunk of memory per tab), we instead elect one tab as the leader tab, and have it's `Worker` be the exclusive way in or out of the FS. The main thread that owns that worker can talk directly to it, and any other tabs can talk to the leader worker via a `BroadcastChannel`. When the leader tab closes, one of the other tabs gets promoted to leader, and starts its own `Worker` that then becomes the single owner.

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

# Credits

- Roy Hashimoto pioneered a lot of this approach when working to get SQLite running in the browser. See https://github.com/rhashimoto/wa-sqlite/discussions/81 for the seed of this idea
- Notion documented their similar approach here: https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite -- this is an open-source implementation of the same one-worker-among-many tabs approach!

## License

MIT
