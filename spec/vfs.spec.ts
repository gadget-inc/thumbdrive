import { test, describe, beforeEach, afterEach, expect } from "vitest";
import { vol } from "memfs";
import "opfs-mock";
import { MemfsFileSystem } from "./MemFSFileSystem";
import { SyncOPFSFileSystem } from "../src/SyncOPFSFileSystem";
import { VirtualFileSystem } from "../src/VirtualFileSystem";

describe.each([
  [
    "memfs",
    async () => {
      const vfs = new MemfsFileSystem();
      await vfs.init();
      return vfs;
    },
    async (_vfs: MemfsFileSystem) => {
      vol.reset();
    },
  ],
  [
    "sync opfs",
    async () => {
      const vfs = new SyncOPFSFileSystem("gadget");
      await vfs.init();
      return vfs;
    },
    async (vfs: SyncOPFSFileSystem) => {
      await vfs.close();
    },
  ],
])("%s vfs", (_name, setup, teardown) => {
  let vfs: VirtualFileSystem;

  beforeEach(async () => {
    vfs = await setup();
  });

  afterEach(async () => {
    await teardown(vfs as any);
  });

  test("write and read file", async () => {
    const path = "/a/b/c.ts";
    const contents = "export const x: number = 1\n";
    await vfs.writeFileEnsuringDirectories(path, contents);

    expect(vfs.existsSync(path)).toBe(true);
    expect(vfs.readFileSync(path, { encoding: "utf8" })).toBe(contents);

    const entries = vfs.readdirSync("/a/b");
    expect(entries).toContain("c.ts");

    const stat = vfs.statSync(path);
    expect(stat.isFile()).toBe(true);
    expect(stat.isDirectory()).toBe(false);
  });

  test("link file and resolve", async () => {
    const target = "/pkg/index.d.ts";
    const alias = "/pkg/alias.d.ts";
    await vfs.writeFileEnsuringDirectories(target, "declare const y: string\n");
    await vfs.linkFileEnsuringDirectories(target, alias);

    expect(vfs.existsSync(alias)).toBe(true);
    const content = vfs.readFileSync(alias, { encoding: "utf8" });
    expect(content).toContain("declare const y");

    const real = vfs.realpathSync(alias);
    expect(typeof real).toBe("string");
  });

  test("delete file removes entry", async () => {
    const path = "/tmp/remove.me";
    await vfs.writeFileEnsuringDirectories(path, "data");
    expect(vfs.existsSync(path)).toBe(true);

    await vfs.deleteFile(path);
    expect(vfs.existsSync(path)).toBe(false);
  });

  test("utimes updates mtime", async () => {
    const path = "/mtime/file.txt";
    await vfs.writeFileEnsuringDirectories(path, "data");
    const before = vfs.statSync(path).mtime.getTime();
    const later = new Date(before + 10_000);
    vfs.utimesSync(path, new Date(before), later);

    const after = vfs.statSync(path).mtime.getTime();
    expect(after).toBeGreaterThanOrEqual(later.getTime());
  });

  test("directory exists after writing file", async () => {
    await vfs.writeFileEnsuringDirectories("/x/y/z/file.ts", "content");
    expect(vfs.existsSync("/x")).toBe(true);
    expect(vfs.existsSync("/x/y")).toBe(true);
    expect(vfs.existsSync("/x/y/z")).toBe(true);
  });

  test("reading nonexistent file throws", () => {
    expect(() => vfs.readFileSync("/does/not/exist.ts")).toThrow();
  });

  test("writeFileSync race condition - multiple writes", async () => {
    // Bug: writeFileSync doesn't await, could lead to race conditions
    const path = "/race/test.ts";
    await vfs.writeFileEnsuringDirectories(path, "first");
    vfs.writeFileSync(path, "second");
    vfs.writeFileSync(path, "third");

    // Give some time for async operations to potentially complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const content = vfs.readFileSync(path, { encoding: "utf8" });
    // The content should be "third" but due to race conditions it might not be
    expect(content).toBe("third");
  });

  test("unlinkSync race condition - file still readable", async () => {
    // Bug: unlinkSync doesn't await deleteFile, so file might still exist
    const path = "/delete/race.ts";
    await vfs.writeFileEnsuringDirectories(path, "data");
    expect(vfs.existsSync(path)).toBe(true);

    vfs.unlinkSync(path);

    // File might still exist immediately after unlinkSync returns
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(vfs.existsSync(path)).toBe(false);
  });

  test("delete alias leaves target intact", async () => {
    const target = "/data/original.ts";
    const alias = "/data/link.ts";

    await vfs.writeFileEnsuringDirectories(target, "original data");
    await vfs.linkFileEnsuringDirectories(target, alias);

    expect(vfs.existsSync(target)).toBe(true);
    expect(vfs.existsSync(alias)).toBe(true);

    await vfs.deleteFile(alias);

    // Target should still exist, alias should be gone
    expect(vfs.existsSync(target)).toBe(true);

    expect(vfs.existsSync(alias)).toBe(false);
  });

  test("circular alias detection", async () => {
    // Test that circular aliases don't cause infinite loops
    const path1 = "/circular/a.ts";
    const path2 = "/circular/b.ts";

    await vfs.writeFileEnsuringDirectories(path1, "data");
    await vfs.linkFileEnsuringDirectories(path1, path2);
    // This would create a cycle if we could link path1 -> path2 -> path1
    // The implementation has cycle detection, but let's verify it works

    const resolved = vfs.realpathSync(path2);
    expect(resolved).toBe(path1);
  });

  test("concurrent writes to same file", async () => {
    // Bug: Multiple concurrent async writes might corrupt data
    const path = "/concurrent/file.ts";

    await Promise.all([
      vfs.writeFileEnsuringDirectories(path, "write1"),
      vfs.writeFileEnsuringDirectories(path, "write2"),
      vfs.writeFileEnsuringDirectories(path, "write3"),
    ]);

    const content = vfs.readFileSync(path, { encoding: "utf8" });
    // Should be one of the writes, not corrupted
    expect(["write1", "write2", "write3"]).toContain(content);
  });

  test("concurrent writes to same file don't create duplicate sync handles", async () => {
    // Regression test: Multiple concurrent writes should not attempt to create
    // multiple sync access handles, which would fail with:
    // "Access Handles cannot be created if there is another open Access Handle"
    const path = "/concurrent-handles/file.ts";

    // Create many concurrent write operations that all try to get sync handles
    const writes = Array.from({ length: 10 }, (_, i) => vfs.writeFileEnsuringDirectories(path, `content-${i}`));

    // This should complete without throwing an error about duplicate access handles
    await Promise.all(writes);

    // Verify file exists and has valid content
    expect(vfs.existsSync(path)).toBe(true);
    const content = vfs.readFileSync(path, { encoding: "utf8" });
    expect(content?.startsWith("content-")).toBe(true);
  });

  test("nested directory creation order", async () => {
    // Verify deeply nested paths work correctly
    const path = "/very/deep/nested/path/to/file.ts";
    await vfs.writeFileEnsuringDirectories(path, "deep");

    // All intermediate directories should exist
    expect(vfs.existsSync("/very")).toBe(true);
    expect(vfs.existsSync("/very/deep")).toBe(true);
    expect(vfs.existsSync("/very/deep/nested")).toBe(true);
    expect(vfs.existsSync("/very/deep/nested/path")).toBe(true);
    expect(vfs.existsSync("/very/deep/nested/path/to")).toBe(true);

    // Should be able to stat each directory
    expect(vfs.statSync("/very").isDirectory()).toBe(true);
    expect(vfs.statSync("/very/deep").isDirectory()).toBe(true);
  });

  test("readdir on nonexistent directory", () => {
    // Should throw ENOENT for non-existent directory (standard filesystem behavior)
    expect(() => vfs.readdirSync("/does/not/exist")).toThrow();
  });

  test("empty file handling", async () => {
    // Edge case: empty files should work correctly
    const path = "/empty/file.ts";
    await vfs.writeFileEnsuringDirectories(path, "");

    expect(vfs.existsSync(path)).toBe(true);
    expect(vfs.readFileSync(path, { encoding: "utf8" })).toBe("");

    const stat = vfs.statSync(path);
    expect(stat.isFile()).toBe(true);
  });

  test("directory alias resolves files inside", async () => {
    const realDir = "/real/dir";
    const aliasDir = "/alias/dir";
    await vfs.writeFileEnsuringDirectories(`${realDir}/file.ts`, "content");
    await vfs.linkFileEnsuringDirectories(realDir, aliasDir);

    expect(vfs.existsSync(`${aliasDir}/file.ts`)).toBe(true);
    expect(vfs.readFileSync(`${aliasDir}/file.ts`, { encoding: "utf8" })).toBe("content");

    const real = vfs.realpathSync(`${aliasDir}/file.ts`);
    expect(real).toBe(`${realDir}/file.ts`);
  });

  test("relative file alias resolves against link's directory", async () => {
    const base = "/pkg";
    await vfs.writeFileEnsuringDirectories(`${base}/index.d.ts`, "declare const z: number\n");
    // Link to a relative target
    await vfs.linkFileEnsuringDirectories("./index.d.ts", `${base}/alias.d.ts`);

    const content = vfs.readFileSync(`${base}/alias.d.ts`, { encoding: "utf8" });
    expect(content).toContain("declare const z");

    const real = vfs.realpathSync(`${base}/alias.d.ts`);
    expect(real).toBe(`${base}/index.d.ts`);
  });

  test("symlink in middle of path is resolved", async () => {
    const realDir = "/packages/lib";
    const linkRoot = "/linked";
    await vfs.writeFileEnsuringDirectories(`${realDir}/src/a.ts`, "export const A = 1\n");
    await vfs.linkFileEnsuringDirectories(realDir, linkRoot);

    const viaLinkPath = `${linkRoot}/src/a.ts`;
    expect(vfs.existsSync(viaLinkPath)).toBe(true);
    expect(vfs.readFileSync(viaLinkPath, { encoding: "utf8" })).toBe("export const A = 1\n");
    expect(vfs.realpathSync(viaLinkPath)).toBe(`${realDir}/src/a.ts`);
  });

  test("readdir through directory alias lists target entries", async () => {
    const real = "/dirsrc";
    const alias = "/diralias";
    await vfs.writeFileEnsuringDirectories(`${real}/x.ts`, "x");
    await vfs.writeFileEnsuringDirectories(`${real}/y.ts`, "y");
    await vfs.linkFileEnsuringDirectories(real, alias);

    const entries = vfs.readdirSync(alias);
    expect(entries).toContain("x.ts");
    expect(entries).toContain("y.ts");
  });

  test("overwriting to shorter content truncates properly", async () => {
    const p = "/truncate/file.ts";
    await vfs.writeFileEnsuringDirectories(p, "longer-content");
    vfs.writeFileSync(p, "short");
    const content = vfs.readFileSync(p, { encoding: "utf8" });
    expect(content).toBe("short");
  });

  test("large file spans multiple blocks and reads back intact", async () => {
    const p = "/big/file.ts";
    // ~150 KiB to cross typical 64 KiB page size a couple times
    const chunk = "x".repeat(50_000);
    const data = chunk + chunk + chunk;
    await vfs.writeFileEnsuringDirectories(p, data);
    const back = vfs.readFileSync(p, { encoding: "utf8" });
    expect(back).toBe(data);
  });

  test("utimesSync persistence", async () => {
    // Bug: utimesSync calls persistIndex without awaiting
    const path = "/mtime/persist.ts";
    await vfs.writeFileEnsuringDirectories(path, "data");

    const newMtime = new Date(Date.now() + 50000);
    vfs.utimesSync(path, new Date(), newMtime);

    // Give time for async persist
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stat = vfs.statSync(path);
    expect(stat.mtime.getTime()).toBeGreaterThanOrEqual(newMtime.getTime());
  });

  test("realpathSync on non-alias returns original", async () => {
    // realpathSync requires the file to exist
    const path = "/regular/file.ts";
    await vfs.writeFileEnsuringDirectories(path, "data");

    const real = vfs.realpathSync(path);
    expect(real).toBe(path);
  });

  test("alias chain resolution", async () => {
    // Test A -> B -> C resolution
    const target = "/target/original.ts";
    const alias1 = "/alias/first.ts";
    const alias2 = "/alias/second.ts";

    await vfs.writeFileEnsuringDirectories(target, "content");
    await vfs.linkFileEnsuringDirectories(target, alias1);
    await vfs.linkFileEnsuringDirectories(alias1, alias2);

    // All should resolve to target
    expect(vfs.realpathSync(alias2)).toBe(target);
    expect(vfs.readFileSync(alias2, { encoding: "utf8" })).toBe("content");
  });

  test("overwriting existing file preserves path", async () => {
    // Ensure overwriting doesn't create duplicate entries
    const path = "/overwrite/test.ts";
    await vfs.writeFileEnsuringDirectories(path, "first");
    await vfs.writeFileEnsuringDirectories(path, "second");

    const content = vfs.readFileSync(path, { encoding: "utf8" });
    expect(content).toBe("second");

    // Check that readdirSync doesn't show duplicates
    const entries = vfs.readdirSync("/overwrite");
    const testFiles = entries.filter((e) => e === "test.ts");
    expect(testFiles).toHaveLength(1);
  });

  test("writeFileSync is truly synchronous", async () => {
    // writeFileSync should complete the write before returning
    const path = "/sync/immediate.ts";
    await vfs.writeFileEnsuringDirectories(path, "initial");

    // Write synchronously
    vfs.writeFileSync(path, "updated");

    // Should be able to read the new content immediately
    const content = vfs.readFileSync(path, { encoding: "utf8" });
    expect(content).toBe("updated");
  });

  test("writeFileSync then existsSync should be consistent", () => {
    // writeFileSync should make file immediately visible
    const path = "/newfile.ts";
    expect(vfs.existsSync(path)).toBe(false);

    vfs.writeFileSync(path, "data");

    // File should exist immediately after writeFileSync returns
    expect(vfs.existsSync(path)).toBe(true);
    expect(vfs.readFileSync(path, { encoding: "utf8" })).toBe("data");
  });

  test("unlinkSync is truly synchronous", async () => {
    // unlinkSync should complete the deletion before returning
    const path = "/sync/delete.ts";
    await vfs.writeFileEnsuringDirectories(path, "data");
    expect(vfs.existsSync(path)).toBe(true);

    // Delete synchronously
    vfs.unlinkSync(path);

    // File should be gone immediately
    expect(vfs.existsSync(path)).toBe(false);
    expect(() => vfs.readFileSync(path, { encoding: "utf8" })).toThrow();
  });

  test("utimesSync updates are immediately visible", async () => {
    // utimesSync should update mtime immediately
    const path = "/sync/mtime.ts";
    await vfs.writeFileEnsuringDirectories(path, "data");

    const oldMtime = vfs.statSync(path).mtime.getTime();
    const newMtime = new Date(oldMtime + 50000);

    vfs.utimesSync(path, new Date(), newMtime);

    // New mtime should be visible immediately
    const stat = vfs.statSync(path);
    expect(stat.mtime.getTime()).toBe(newMtime.getTime());
  });

  test("list unknown directory", () => {
    expect(() => vfs.readdirSync("/does/not/exist")).toThrow();
  });

  test("write file without directory separator uses correct parent directory", async () => {
    const filename = "standalone.ts";
    await vfs.writeFileEnsuringDirectories(filename, "content");

    expect(vfs.existsSync(filename)).toBe(true);
    expect(vfs.readFileSync(filename, { encoding: "utf8" })).toBe("content");

    // Verify the file is in current directory ".", not root "/"
    const stat = vfs.statSync(filename);
    expect(stat.isFile()).toBe(true);
  });

  test("link file without directory separator uses correct parent directory", async () => {
    const target = "target.ts";
    const link = "link.ts";

    await vfs.writeFileEnsuringDirectories(target, "data");
    await vfs.linkFileEnsuringDirectories(target, link);

    expect(vfs.existsSync(link)).toBe(true);
    expect(vfs.readFileSync(link, { encoding: "utf8" })).toBe("data");
  });
});
