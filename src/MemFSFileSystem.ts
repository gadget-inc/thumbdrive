import { fs, vol } from "memfs";
import path from "path";
import { VirtualFileSystem } from "./VirtualFileSystem.js";

// Memfs implementation
export class MemfsFileSystem implements VirtualFileSystem {
  async init() {
    if (!vol.existsSync("/")) {
      vol.fromJSON({});
    }
  }

  async writeFileEnsuringDirectories(absPath: string, contents: string): Promise<void> {
    try {
      fs.writeFileSync(absPath, contents);
    } catch (_) {
      const dirname = path.dirname(absPath);
      fs.mkdirSync(dirname, { recursive: true } as any);
      fs.writeFileSync(absPath, contents);
    }
  }

  async linkFileEnsuringDirectories(target: string, linkPath: string): Promise<void> {
    try {
      fs.symlinkSync(target, linkPath);
    } catch (_) {
      const dirname = path.dirname(linkPath);
      fs.mkdirSync(dirname, { recursive: true } as any);
      fs.symlinkSync(target, linkPath);
    }
  }

  async deleteFile(absPath: string): Promise<void> {
    fs.unlinkSync(absPath);
  }

  async touch(absPath: string, mtime: Date): Promise<void> {
    fs.utimesSync(absPath, mtime, mtime);
  }

  readFileSync(path: string, opts?: { encoding?: string }): string {
    const data = fs.readFileSync(path, { encoding: "utf8" }) as any;
    return data as string;
  }

  writeFileSync(path: string, data: string): void {
    return fs.writeFileSync(path, data, { encoding: "utf8" });
  }

  existsSync(path: string): boolean {
    return fs.existsSync(path);
  }

  realpathSync(path: string): string {
    return fs.realpathSync(path).toString();
  }

  statSync(path: string): { mtime: Date; isFile: () => boolean; isDirectory: () => boolean } {
    return fs.statSync(path) as any;
  }

  utimesSync(path: string, atime: Date, mtime: Date): void {
    fs.utimesSync(path, atime, mtime);
  }

  unlinkSync(path: string): void {
    fs.unlinkSync(path);
  }

  readdirSync(path: string, _opts?: { withFileTypes?: boolean }): string[] {
    return fs.readdirSync(path) as any;
  }

  dumpFileSystem(): void {
    // eslint-disable-next-line no-console
    console.log("memfs vol:", vol.toJSON("/"));
  }
}
