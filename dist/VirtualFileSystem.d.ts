/**
 * Virtual file system interface we use to host TypeScript in the language server
 **/
export interface VirtualFileSystem {
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
    readdirSync(path: string, opts?: {
        withFileTypes?: boolean;
    }): string[];
    writeFileEnsuringDirectories(absPath: string, contents: string): Promise<void>;
    linkFileEnsuringDirectories(target: string, linkPath: string): Promise<void>;
    deleteFile(absPath: string): Promise<void>;
    touch(absPath: string, mtime: Date): Promise<void>;
    dumpFileSystem(): void;
}
