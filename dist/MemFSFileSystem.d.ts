import { VirtualFileSystem } from "./VirtualFileSystem.js";
export declare class MemfsFileSystem implements VirtualFileSystem {
    init(): Promise<void>;
    writeFileEnsuringDirectories(absPath: string, contents: string): Promise<void>;
    linkFileEnsuringDirectories(target: string, linkPath: string): Promise<void>;
    deleteFile(absPath: string): Promise<void>;
    touch(absPath: string, mtime: Date): Promise<void>;
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
    utimesSync(path: string, atime: Date, mtime: Date): void;
    unlinkSync(path: string): void;
    readdirSync(path: string, _opts?: {
        withFileTypes?: boolean;
    }): string[];
    dumpFileSystem(): void;
}
