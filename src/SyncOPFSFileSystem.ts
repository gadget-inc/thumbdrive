import path from "path";
import { VirtualFileSystem } from "./VirtualFileSystem.js";

/**
 * A simple, synchronous VFS backed by a pre-opened OPFS sync access handle treated as a paged arena. Only metadata (paths, dir tree, symlinks, extents) lives in memory; file bytes live in the arena.
 *
 * Notes:
 * - No persistence of the in-memory index yet.
 * - Immediate space reclamation on overwrite/unlink.
 * - Best-effort contiguous allocations; accepts fragmentation.
 */
export class SyncOPFSFileSystem implements VirtualFileSystem {
  private arenaHandle!: FileSystemSyncAccessHandle;

  // Free list of pages within arena
  private freeList: FreeRange[] = [];

  // Root directory and in-memory tree (absolute namespace only for now)
  private root: DirNode = { type: "dir", mtimeMs: nowMs(), children: new Map() };

  private allocatedBytes = 0;

  constructor(readonly arenaDirName: string) {}

  async init() {
    const arenaFile = "arena.bin";
    const initialGrowBytes = 32 * 1024 * 1024; // 32MiB

    // Open OPFS directory and arena file; create sync access handle
    const dirHandle = await (await navigator.storage.getDirectory()).getDirectoryHandle(this.arenaDirName, { create: true });
    const fileHandle: FileSystemFileHandle = await dirHandle.getFileHandle(arenaFile, { create: true });
    this.arenaHandle = await fileHandle.createSyncAccessHandle();
    if (!this.arenaHandle || typeof (this.arenaHandle as any).getSize !== "function") {
      throw new Error("SyncAccessHandle unavailable or invalid in this environment");
    }

    // Ensure non-zero size to simplify allocation
    const size = this.arenaHandle.getSize();
    if (size === 0 && initialGrowBytes > 0) {
      this.arenaHandle.truncate(initialGrowBytes);
      const newPages = Math.floor(initialGrowBytes / PAGE_SIZE);
      if (newPages > 0) this.freeList.push({ startPage: 0, pageCount: newPages });
    } else if (size > 0) {
      // Treat whole current file as free space (fresh start each boot)
      const pages = Math.floor(size / PAGE_SIZE);
      if (pages > 0) this.freeList.push({ startPage: 0, pageCount: pages });
    }
  }

  async close() {
    this.arenaHandle.close();
  }

  // Persist/restore API for index/state
  exportIndex(): PersistedIndexState {
    return {
      root: this.serializeNode(this.root),
      freeList: this.freeList.slice(),
      allocatedBytes: this.allocatedBytes,
      pageSize: PAGE_SIZE,
    };
  }

  importIndex(snapshot: PersistedIndexState): void {
    // Basic validation on page size compatibility
    if (snapshot.pageSize !== PAGE_SIZE) throw new Error("incompatible page size");
    this.root = this.deserializeNode(snapshot.root) as DirNode;
    this.freeList = snapshot.freeList.slice();
    this.allocatedBytes = snapshot.allocatedBytes;
  }

  readFileSync(path: string, opts?: { encoding?: string }): string {
    const node = this.getNodeResolved(path);
    if (!node) throw new Error("ENOENT: no such file or directory, readfile '" + path + "'");
    if (node.type === "symlink") return this.readFileSync(this.realpathSync(path), opts);
    if (node.type !== "file") throw new Error("ENOTFILE: not a file, readfile '" + path + "'");
    const bytes = this.readFileBytes(node);
    if (!bytes) throw new Error("EIO: readfile '" + path + "'");

    // Only utf8 supported for now
    return new TextDecoder().decode(bytes);
  }

  writeFileSync(path: string, data: string): void {
    const abs = ensureAbsolute(path);
    this.ensureParentDirectories(abs);
    const parent = this.getDir(dirname(abs));
    const name = basename(abs);
    const encoded = new TextEncoder().encode(data);

    const existing = parent.children.get(name);
    if (existing && existing.type === "file") {
      // Copy-on-write: allocate, write, then free old extents
      const newExtents = this.allocateExtents(encoded.byteLength);
      this.writeBytesToExtents(newExtents, encoded);
      // Subtract the old page-aligned allocation before freeing
      const oldAllocatedPages = existing.extents.reduce((sum, e) => sum + e.pageCount, 0);
      this.allocatedBytes -= oldAllocatedPages * PAGE_SIZE;
      this.freeExtents(existing.extents);
      existing.mtimeMs = nowMs();
      existing.size = encoded.byteLength;
      existing.extents = newExtents;
      return;
    }

    if (existing && existing.type === "symlink") {
      // Follow symlink target and write there
      this.writeFileSync(this.realpathSync(abs), data);
      return;
    }

    // New file
    const extents = this.allocateExtents(encoded.byteLength);
    this.writeBytesToExtents(extents, encoded);
    const fileNode: FileNode = {
      type: "file",
      mtimeMs: nowMs(),
      size: encoded.byteLength,
      extents,
    };
    parent.children.set(name, fileNode);
    parent.mtimeMs = nowMs();
  }

  existsSync(path: string): boolean {
    const n = this.getNode(path, true);
    return !!n;
  }

  realpathSync(path: string): string {
    // Resolve symlinks anywhere in the path, returning a canonical absolute path
    let current = ensureAbsolute(path);
    const visited = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const { resolvedPath, finalNode, endedOnSymlink } = this.resolvePathFollowingSymlinks(current, true /* resolveFinal */);
      if (!endedOnSymlink) return resolvedPath;
      if (visited.has(resolvedPath)) throw new Error("symlink cycle detected");
      visited.add(resolvedPath);
      // If still a symlink, expand and continue
      const link = finalNode as SymlinkNode;
      current = this.normalizeAndJoin(dirname(resolvedPath), link.target);
    }
    throw new Error("too many symlink levels");
  }

  statSync(path: string): { mtime: Date; isFile: () => boolean; isDirectory: () => boolean } {
    const node = this.getNode(path, true);
    if (!node) throw new Error("ENOENT: no such file or directory, stat '" + path + "'");
    return {
      mtime: new Date(node.mtimeMs),
      isFile: () => node.type === "file",
      isDirectory: () => node.type === "dir",
    };
  }

  utimesSync(path: string, _atime: Date, mtime: Date): void {
    const node = this.getNode(path, true);
    if (!node) throw new Error("ENOENT: no such file or directory, utimes '" + path + "'");
    node.mtimeMs = mtime.getTime();
  }

  unlinkSync(path: string): void {
    const abs = ensureAbsolute(path);
    const parent = this.getDir(dirname(abs));
    const name = basename(abs);
    const node = parent.children.get(name);
    if (!node) return; // idempotent
    if (node.type === "file") {
      this.freeExtents(node.extents);
      const allocatedPages = node.extents.reduce((sum, e) => sum + e.pageCount, 0);
      this.allocatedBytes -= allocatedPages * PAGE_SIZE;
    }
    parent.children.delete(name);
    parent.mtimeMs = nowMs();
  }

  readdirSync(path: string, _opts?: { withFileTypes?: boolean }): string[] {
    const dir = this.getDir(path);
    return Array.from(dir.children.keys());
  }

  async writeFileEnsuringDirectories(absPath: string, contents: string): Promise<void> {
    const abs = ensureAbsolute(absPath);
    this.ensureParentDirectories(abs);
    this.writeFileSync(abs, contents);
  }

  async linkFileEnsuringDirectories(target: string, linkPath: string): Promise<void> {
    const absLink = ensureAbsolute(linkPath);
    this.ensureParentDirectories(absLink);
    const parent = this.getDir(dirname(absLink));
    parent.children.set(basename(absLink), { type: "symlink", mtimeMs: nowMs(), target: target } as SymlinkNode);
    parent.mtimeMs = nowMs();
  }

  async deleteFile(absPath: string): Promise<void> {
    this.unlinkSync(absPath);
  }

  async touch(absPath: string, mtime: Date): Promise<void> {
    this.utimesSync(absPath, mtime, mtime);
  }

  dumpFileSystem(): void {
    // eslint-disable-next-line no-console
    console.log("[opfs] tree:", this.debugTree("/"));
  }

  private serializeNode(node: Node): PersistedNode {
    if (node.type === "dir") {
      const children: Record<string, PersistedNode> = {};
      for (const [name, child] of node.children) children[name] = this.serializeNode(child);
      return { type: "dir", mtimeMs: node.mtimeMs, children };
    }
    if (node.type === "file") {
      return { type: "file", mtimeMs: node.mtimeMs, size: node.size, extents: node.extents.map((e: FileExtent) => ({ ...e })) };
    }
    return { type: "symlink", mtimeMs: node.mtimeMs, target: node.target };
  }

  private deserializeNode(p: PersistedNode): Node {
    if (p.type === "dir") {
      const m = new Map<string, Node>();
      for (const k of Object.keys(p.children)) m.set(k, this.deserializeNode(p.children[k]!));
      return { type: "dir", mtimeMs: p.mtimeMs, children: m };
    }
    if (p.type === "file") {
      return { type: "file", mtimeMs: p.mtimeMs, size: p.size, extents: p.extents.map((e: FileExtent) => ({ ...e })) };
    }
    return { type: "symlink", mtimeMs: p.mtimeMs, target: p.target };
  }

  private getNodeResolved(path: string): Node | undefined {
    const node = this.getNode(path, false);
    if (!node) return undefined;
    if (node.type === "symlink") return this.getNode(this.realpathSync(path), false);
    return node;
  }

  private getDir(path: string): DirNode {
    const abs = ensureAbsolute(path);
    if (abs === "/") return this.root;
    const { finalNode } = this.resolvePathFollowingSymlinks(abs, true);
    if (!finalNode) throw new Error("ENOENT: no such file or directory, scandir '" + path + "'");
    if (finalNode.type !== "dir") throw new Error("ENOTDIR: not a directory, scandir '" + path + "'");
    return finalNode;
  }

  private getNode(path: string, resolveSymlink: boolean): Node | undefined {
    const abs = ensureAbsolute(path);
    if (abs === "/") return this.root;
    const { finalNode } = this.resolvePathFollowingSymlinks(abs, resolveSymlink);
    return finalNode;
  }

  private ensureParentDirectories(path: string) {
    const abs = ensureAbsolute(path);
    const dirPath = dirname(abs);
    if (dirPath === "/") return;
    const parts = splitPath(dirPath);
    let curDir = this.root;
    let curPathParts: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const existing = curDir.children.get(part);
      if (!existing) {
        const newDir: DirNode = { type: "dir", mtimeMs: nowMs(), children: new Map() };
        curDir.children.set(part, newDir);
        curDir.mtimeMs = nowMs();
        curDir = newDir;
        curPathParts.push(part);
        continue;
      }

      if (existing.type === "dir") {
        curDir = existing;
        curPathParts.push(part);
        continue;
      }

      // Symlink encountered in the path; resolve and continue creation under target
      if (existing.type === "symlink") {
        const baseDir = "/" + curPathParts.join("/");
        const targetAbs = this.normalizeAndJoin(baseDir || "/", existing.target);
        // Ensure the target directory exists up to this point
        curDir = this.getOrCreateDir(targetAbs);
        curPathParts = splitPath(targetAbs);
        continue;
      }

      // Otherwise (file), invalid
      throw new Error("ENOTDIR: path segment is not a directory");
    }
  }

  private getOrCreateDir(absDirPath: string): DirNode {
    const abs = ensureAbsolute(absDirPath);
    if (abs === "/") return this.root;
    const parts = splitPath(abs);
    let cur = this.root;
    for (const part of parts) {
      const next = cur.children.get(part);
      if (!next) {
        const newDir: DirNode = { type: "dir", mtimeMs: nowMs(), children: new Map() };
        cur.children.set(part, newDir);
        cur.mtimeMs = nowMs();
        cur = newDir;
      } else if (next.type === "dir") {
        cur = next;
      } else if (next.type === "symlink") {
        // Follow symlink and continue creation at target
        const baseDir = "/" + parts.slice(0, parts.indexOf(part)).join("/");
        const targetAbs = this.normalizeAndJoin(baseDir || "/", next.target);
        cur = this.getOrCreateDir(targetAbs);
      } else {
        throw new Error("ENOTDIR: path segment is not a directory");
      }
    }
    return cur;
  }

  private allocateExtents(byteLength: number): FileExtent[] {
    if (byteLength === 0) return [];
    const pagesNeeded = Math.ceil(byteLength / PAGE_SIZE);
    const out: FileExtent[] = [];
    let remaining = pagesNeeded;

    // Try to fulfill from existing free ranges first
    this.coalesceFreeList();
    for (let i = 0; i < this.freeList.length && remaining > 0; i++) {
      const r = this.freeList[i];
      if (r.pageCount === 0) continue;
      const take = Math.min(r.pageCount, remaining);
      out.push({ startPage: r.startPage, pageCount: take });
      r.startPage += take;
      r.pageCount -= take;
      remaining -= take;
      if (r.pageCount === 0) {
        this.freeList.splice(i, 1);
        i--;
      }
    }

    if (remaining > 0) {
      // Grow arena and retry once
      const growPages = Math.max(remaining, GROW_PAGES_CHUNK);
      this.growArenaByPages(growPages);
      // After grow, we should have a contiguous free range at the end
      const endRange = this.freeList[this.freeList.length - 1];
      const take = Math.min(endRange.pageCount, remaining);
      out.push({ startPage: endRange.startPage, pageCount: take });
      endRange.startPage += take;
      endRange.pageCount -= take;
      remaining -= take;
      if (endRange.pageCount === 0) this.freeList.pop();
    }

    if (remaining > 0) throw new Error("ENOSPC: could not allocate extents");
    this.allocatedBytes += pagesNeeded * PAGE_SIZE;
    return out;
  }

  private freeExtents(extents: FileExtent[]) {
    for (const e of extents) this.freeList.push({ startPage: e.startPage, pageCount: e.pageCount });
    this.coalesceFreeList();
  }

  private coalesceFreeList() {
    if (this.freeList.length <= 1) return;
    this.freeList.sort((a, b) => a.startPage - b.startPage);
    const merged: FreeRange[] = [];
    let cur = this.freeList[0];
    for (let i = 1; i < this.freeList.length; i++) {
      const n = this.freeList[i];
      if (cur.startPage + cur.pageCount === n.startPage) {
        cur = { startPage: cur.startPage, pageCount: cur.pageCount + n.pageCount };
      } else {
        merged.push(cur);
        cur = n;
      }
    }
    merged.push(cur);
    this.freeList = merged;
  }

  private growArenaByPages(pages: number) {
    const oldBytes = this.arenaHandle.getSize();
    const addBytes = pages * PAGE_SIZE;
    this.arenaHandle.truncate(oldBytes + addBytes);
    const startPage = Math.floor(oldBytes / PAGE_SIZE);
    this.freeList.push({ startPage, pageCount: pages });
    this.coalesceFreeList();
  }

  private writeBytesToExtents(extents: FileExtent[], data: Uint8Array) {
    let offset = 0;
    for (const e of extents) {
      const bytes = Math.min(e.pageCount * PAGE_SIZE, data.byteLength - offset);
      if (bytes <= 0) break;
      const at = e.startPage * PAGE_SIZE;
      this.arenaHandle.write(new Uint8Array(data.buffer, data.byteOffset + offset, bytes), { at });
      offset += bytes;
    }
  }

  private readFileBytes(node: FileNode): Uint8Array | undefined {
    const out = new Uint8Array(node.size);
    let offset = 0;
    for (const e of node.extents) {
      const bytes = Math.min(e.pageCount * PAGE_SIZE, node.size - offset);
      if (bytes <= 0) break;
      const at = e.startPage * PAGE_SIZE;
      // Read into a temp buffer view to avoid over-read
      const tmp = new Uint8Array(out.buffer, out.byteOffset + offset, bytes);
      this.arenaHandle.read(tmp, { at });
      offset += bytes;
    }
    return out;
  }

  private debugTree(path: string): any {
    const node = this.getNode(path, false);
    if (!node) return null;
    if (node.type === "dir") {
      const children: Record<string, any> = {};
      for (const [name] of node.children) children[name] = this.debugTree((path === "/" ? "" : path) + "/" + name);
      return { type: "dir", children };
    }
    if (node.type === "file") return { type: "file", size: node.size, extents: node.extents };
    return { type: "symlink", target: node.target };
  }

  // Resolve symlinks during traversal; if resolveFinal is true, also resolve final symlink to its target
  private resolvePathFollowingSymlinks(
    inputPath: string,
    resolveFinal: boolean
  ): { resolvedPath: string; finalNode?: Node; endedOnSymlink: boolean } {
    let path = ensureAbsolute(this.normalize(inputPath));
    if (path === "/") return { resolvedPath: "/", finalNode: this.root, endedOnSymlink: false };

    const visited = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      const parts = splitPath(path);
      let cur: Node = this.root;
      let consumed = 0;
      for (; consumed < parts.length; consumed++) {
        if (cur.type !== "dir") return { resolvedPath: path, finalNode: undefined, endedOnSymlink: false };
        const curDir: DirNode = cur;
        const next = curDir.children.get(parts[consumed]);
        if (!next) return { resolvedPath: path, finalNode: undefined, endedOnSymlink: false };
        if (next.type === "symlink" && (consumed < parts.length - 1 || resolveFinal)) {
          // Build remaining path after the symlink
          const remaining = parts.slice(consumed + 1).join("/");
          const baseDir = "/" + parts.slice(0, consumed).join("/");
          const linkTarget = next.target;
          const joined = remaining
            ? this.normalizeAndJoin(baseDir || "/", linkTarget + "/" + remaining)
            : this.normalizeAndJoin(baseDir || "/", linkTarget);
          if (visited.has(joined)) throw new Error("symlink cycle detected");
          visited.add(joined);
          path = joined;
          // Restart outer loop to re-walk from root
          break;
        }
        cur = next;
      }
      if (consumed === parts.length) {
        // Finished walking without triggering a symlink redirect
        const endedOnSymlink = cur.type === "symlink" && resolveFinal;
        return { resolvedPath: path, finalNode: cur, endedOnSymlink };
      }
      // else: loop continues to follow symlink
    }
    throw new Error("too many symlink levels");
  }

  private normalizeAndJoin(baseDir: string, target: string): string {
    if (target.startsWith("/")) return this.normalize(target);
    const prefix = baseDir.endsWith("/") ? baseDir : baseDir + "/";
    return this.normalize(prefix + target);
  }

  private normalize(path: string): string {
    const isAbs = path.startsWith("/");
    const parts = path.replace(/\\/g, "/").split("/");
    const out: string[] = [];
    for (const p of parts) {
      if (!p || p === ".") continue;
      if (p === "..") {
        if (out.length > 0) out.pop();
        continue;
      }
      out.push(p);
    }
    const joined = (isAbs ? "/" : "") + out.join("/");
    return joined || (isAbs ? "/" : "");
  }
}

export interface PersistedIndexState {
  root: PersistedNode;
  freeList: FreeRange[];
  allocatedBytes: number;
  pageSize: number;
}

export type PersistedNode =
  | { type: "dir"; mtimeMs: number; children: Record<string, PersistedNode> }
  | { type: "file"; mtimeMs: number; size: number; extents: FileExtent[] }
  | { type: "symlink"; mtimeMs: number; target: string };

type NodeType = "file" | "dir" | "symlink";

interface BaseNode {
  type: NodeType;
  mtimeMs: number;
}

interface DirNode extends BaseNode {
  type: "dir";
  children: Map<string, Node>;
}

interface FileExtent {
  startPage: number; // inclusive
  pageCount: number;
}

interface FileNode extends BaseNode {
  type: "file";
  size: number;
  extents: FileExtent[];
}

interface SymlinkNode extends BaseNode {
  type: "symlink";
  target: string;
}

type Node = DirNode | FileNode | SymlinkNode;

interface FreeRange {
  startPage: number;
  pageCount: number;
}

const PAGE_SIZE = 64 * 1024; // 64KiB pages
const GROW_PAGES_CHUNK = 512; // grows ~32MiB at a time

const nowMs = () => Date.now();

const ensureAbsolute = (pathStr: string) => (pathStr.startsWith("/") ? pathStr : "/" + pathStr);

const splitPath = (pathStr: string): string[] => ensureAbsolute(pathStr).split("/").filter(Boolean);

const dirname = (pathStr: string) => path.dirname(pathStr);

const basename = (pathStr: string) => path.basename(pathStr);
