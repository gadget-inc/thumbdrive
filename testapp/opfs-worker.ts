import { createMessageConnection } from "vscode-jsonrpc";
import { BrowserMessageReader, BrowserMessageWriter } from "vscode-languageserver/browser";
import { SyncOPFSFileSystem } from "../src/SyncOPFSFileSystem";
import { ExistsRequest, InitializeRequest, ReadFileRequest, ShutdownRequest, WriteFileRequest } from "./requests";

// Set up JSON-RPC connection
const reader = new BrowserMessageReader(self);
const writer = new BrowserMessageWriter(self);
const connection = createMessageConnection(reader, writer);
let vfs: SyncOPFSFileSystem | null = null;

// Register JSON-RPC methods
connection.onRequest(InitializeRequest, async (params: { arena: string }) => {
  vfs = new SyncOPFSFileSystem(params.arena);
  await vfs.init();
  return { success: true };
});

connection.onRequest(WriteFileRequest, async (params: { path: string; data: string }) => {
  if (!vfs) throw new Error("VFS not initialized");
  await vfs.writeFileEnsuringDirectories(params.path, params.data);
  return { success: true };
});

connection.onRequest(ReadFileRequest, async (params: { path: string }) => {
  if (!vfs) throw new Error("VFS not initialized");
  return { data: vfs.readFileSync(params.path, { encoding: "utf8" }) };
});

connection.onRequest(ExistsRequest, async (params: { path: string }) => {
  if (!vfs) throw new Error("VFS not initialized");
  return { exists: vfs.existsSync(params.path) };
});

connection.onRequest(ShutdownRequest, async () => {
  if (vfs) {
    await vfs.close();
    vfs = null;
  }

  return { success: true };
});

connection.listen();
