import { VirtualFileSystem } from "./VirtualFileSystem.js";
/**
 * A simple, synchronous VFS backed by a pre-opened OPFS sync access handle treated as a paged arena. Only metadata (paths, dir tree, symlinks, extents) lives in memory; file bytes live in the arena.
 *
 * Notes:
 * - No persistence of the in-memory index yet.
 * - Immediate space reclamation on overwrite/unlink.
 * - Best-effort contiguous allocations; accepts fragmentation.
 */
export declare class SyncOPFSFileSystem implements VirtualFileSystem {
    readonly arenaDirName: string;
    private arenaHandle;
    private freeList;
    private root;
    private allocatedBytes;
    constructor(arenaDirName: string);
    init(): Promise<void>;
    close(): Promise<void>;
    exportIndex(): PersistedIndexState;
    importIndex(snapshot: PersistedIndexState): void;
    readFileSync(path: string, opts?: {
        encoding?: string;
    }): string;
    writeFileSync(path: string, data: string): void;
    existsSync(path: string): boolean;
    realpathSync(path: string): string;
    statSync(path: string): {
        mtime: Date;
        isFile: () => boolean;
        isDirectory: () => boolean;
    };
    utimesSync(path: string, _atime: Date, mtime: Date): void;
    unlinkSync(path: string): void;
    readdirSync(path: string, _opts?: {
        withFileTypes?: boolean;
    }): string[];
    writeFileEnsuringDirectories(absPath: string, contents: string): Promise<void>;
    linkFileEnsuringDirectories(target: string, linkPath: string): Promise<void>;
    deleteFile(absPath: string): Promise<void>;
    touch(absPath: string, mtime: Date): Promise<void>;
    dumpFileSystem(): void;
    private serializeNode;
    private deserializeNode;
    private getNodeResolved;
    private getDir;
    private getNode;
    private ensureParentDirectories;
    private getOrCreateDir;
    private allocateExtents;
    private freeExtents;
    private coalesceFreeList;
    private growArenaByPages;
    private writeBytesToExtents;
    private readFileBytes;
    private debugTree;
    private resolvePathFollowingSymlinks;
    private normalizeAndJoin;
    private normalize;
}
export interface PersistedIndexState {
    root: PersistedNode;
    freeList: FreeRange[];
    allocatedBytes: number;
    pageSize: number;
}
export type PersistedNode = {
    type: "dir";
    mtimeMs: number;
    children: Record<string, PersistedNode>;
} | {
    type: "file";
    mtimeMs: number;
    size: number;
    extents: FileExtent[];
} | {
    type: "symlink";
    mtimeMs: number;
    target: string;
};
interface FileExtent {
    startPage: number;
    pageCount: number;
}
interface FreeRange {
    startPage: number;
    pageCount: number;
}
export {};
