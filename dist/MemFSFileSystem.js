import { fs, vol } from "memfs";
import path from "path";
// Memfs implementation
export class MemfsFileSystem {
    async init() {
        if (!vol.existsSync("/")) {
            vol.fromJSON({});
        }
    }
    async writeFileEnsuringDirectories(absPath, contents) {
        try {
            fs.writeFileSync(absPath, contents);
        }
        catch (_) {
            const dirname = path.dirname(absPath);
            fs.mkdirSync(dirname, { recursive: true });
            fs.writeFileSync(absPath, contents);
        }
    }
    async linkFileEnsuringDirectories(target, linkPath) {
        try {
            fs.symlinkSync(target, linkPath);
        }
        catch (_) {
            const dirname = path.dirname(linkPath);
            fs.mkdirSync(dirname, { recursive: true });
            fs.symlinkSync(target, linkPath);
        }
    }
    async deleteFile(absPath) {
        fs.unlinkSync(absPath);
    }
    async touch(absPath, mtime) {
        fs.utimesSync(absPath, mtime, mtime);
    }
    readFileSync(path, opts) {
        const data = fs.readFileSync(path, { encoding: "utf8" });
        return data;
    }
    writeFileSync(path, data) {
        return fs.writeFileSync(path, data, { encoding: "utf8" });
    }
    existsSync(path) {
        return fs.existsSync(path);
    }
    realpathSync(path) {
        return fs.realpathSync(path).toString();
    }
    statSync(path) {
        return fs.statSync(path);
    }
    utimesSync(path, atime, mtime) {
        fs.utimesSync(path, atime, mtime);
    }
    unlinkSync(path) {
        fs.unlinkSync(path);
    }
    readdirSync(path, _opts) {
        return fs.readdirSync(path);
    }
    dumpFileSystem() {
        // eslint-disable-next-line no-console
        console.log("memfs vol:", vol.toJSON("/"));
    }
}
