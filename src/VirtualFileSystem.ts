/**
 * Virtual file system interface we use to host TypeScript in the language server
 **/
export interface VirtualFileSystem {
  // Sync operations (used by TypeScript host)
  readFileSync(path: string, opts?: { encoding?: string }): string;
  writeFileSync(path: string, data: string): void;
  existsSync(path: string): boolean;
  realpathSync(path: string): string;
  statSync(path: string): { mtime: Date; isFile: () => boolean; isDirectory: () => boolean };
  utimesSync(path: string, atime: Date, mtime: Date): void;
  unlinkSync(path: string): void;
  readdirSync(path: string, opts?: { withFileTypes?: boolean }): string[];

  // Async write operations (used by worker request handlers)
  writeFileEnsuringDirectories(absPath: string, contents: string): Promise<void>;
  linkFileEnsuringDirectories(target: string, linkPath: string): Promise<void>;
  deleteFile(absPath: string): Promise<void>;
  touch(absPath: string, mtime: Date): Promise<void>;

  // Debug
  dumpFileSystem(): void;
}
