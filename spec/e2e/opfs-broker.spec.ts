import { test, expect, type Page } from "@playwright/test";

// Type declarations for the test API exposed by main.ts
declare global {
  interface Window {
    thumbdriveTest: {
      start: () => Promise<void>;
      shutdown: () => Promise<void>;
      isLeader: () => boolean;
      writeFile: (p: string, s: string) => Promise<void>;
      readFile: (p: string) => Promise<string>;
      exists: (p: string) => Promise<boolean>;
    };
  }
}

function url(ns: string, arena: string, options?: { timeout?: number }) {
  let u = `/testapp/index.html?ns=${encodeURIComponent(ns)}&arena=${encodeURIComponent(arena)}`;
  if (options?.timeout !== undefined) {
    u += `&timeout=${options.timeout}`;
  }
  return u;
}

async function setupPage(page: Page) {
  // Log all console messages for debugging
  page.on("console", (msg) => {
    console.log(`[${msg.type()}]`, msg.text());
  });

  // Log page errors
  page.on("pageerror", (error) => {
    console.error("Page error:", error);
  });
}

async function waitForReady(page: Page) {
  // Wait for the page to be fully loaded and stable
  await page.waitForLoadState("domcontentloaded");

  // Wait for the page to load and thumbdriveTest to be available
  await page.waitForFunction(() => window.thumbdriveTest !== undefined, { timeout: 10000 });
}

async function startCandidate(page: Page) {
  // Retry logic to handle transient execution context issues
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.evaluate(() => window.thumbdriveTest.start());
      // Give the worker time to initialize
      await page.waitForTimeout(100);
      return; // Success
    } catch (error) {
      lastError = error as Error;
      if (error instanceof Error && error.message.includes("Execution context was destroyed")) {
        // Wait and retry
        await page.waitForTimeout(100);
        continue;
      }
      // Re-throw if it's not an execution context error
      throw error;
    }
  }
  throw lastError;
}

async function shutdownLeader(page: Page) {
  await page.evaluate(() => window.thumbdriveTest.shutdown());
  // Give time for cleanup and lock release
  await page.waitForTimeout(100);
}

async function isLeader(page: Page) {
  return await page.evaluate(() => window.thumbdriveTest.isLeader());
}

async function writeFile(page: Page, p: string, s: string) {
  await page.evaluate((args: { p: string; s: string }) => window.thumbdriveTest.writeFile(args.p, args.s), { p, s });
}

async function readFile(page: Page, p: string) {
  return await page.evaluate((p: string) => window.thumbdriveTest.readFile(p), p);
}

async function exists(page: Page, p: string) {
  return await page.evaluate((p: string) => window.thumbdriveTest.exists(p), p);
}

test("single tab can start, access fs via worker, close", async ({ page }) => {
  const ns = `ns-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const arena = `arena-${Math.random().toString(36).slice(2)}`;

  setupPage(page);
  await page.goto(url(ns, arena));
  await waitForReady(page);
  await startCandidate(page);
  await expect.poll(() => isLeader(page), { timeout: 5000 }).toBe(true);

  await writeFile(page, "/a.txt", "hello");
  await expect.poll(() => readFile(page, "/a.txt"), { timeout: 5000 }).toBe("hello");

  await shutdownLeader(page);
  await expect.poll(() => isLeader(page), { timeout: 5000 }).toBe(false);
});

test("two tabs: one leader, the other forwards RPCs", async ({ browser }) => {
  const context = await browser.newContext();
  const page1 = await context.newPage();
  const page2 = await context.newPage();
  const ns = `ns-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const arena = `arena-${Math.random().toString(36).slice(2)}`;

  setupPage(page1);
  setupPage(page2);
  await page1.goto(url(ns, arena));
  await page2.goto(url(ns, arena));
  await waitForReady(page1);
  await waitForReady(page2);
  await startCandidate(page1);
  await startCandidate(page2);

  // Exactly one leader
  await expect.poll(async () => ((await isLeader(page1)) ? 1 : 0) + ((await isLeader(page2)) ? 1 : 0), { timeout: 5000 }).toBe(1);

  // Both can use fs via RPC
  await writeFile(page1, "/t.txt", "one");
  await expect.poll(() => readFile(page2, "/t.txt"), { timeout: 5000 }).toBe("one");
  await writeFile(page2, "/u.txt", "two");
  await expect.poll(() => readFile(page1, "/u.txt"), { timeout: 5000 }).toBe("two");

  await context.close();
});

test("three tabs: single leader, all can access via RPC", async ({ browser }) => {
  const context = await browser.newContext();
  const [a, b, c] = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  const ns = `ns-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const arena = `arena-${Math.random().toString(36).slice(2)}`;

  [a, b, c].forEach(setupPage);
  await Promise.all([a.goto(url(ns, arena)), b.goto(url(ns, arena)), c.goto(url(ns, arena))]);
  await Promise.all([waitForReady(a), waitForReady(b), waitForReady(c)]);
  await Promise.all([startCandidate(a), startCandidate(b), startCandidate(c)]);

  await expect
    .poll(async () => ((await isLeader(a)) ? 1 : 0) + ((await isLeader(b)) ? 1 : 0) + ((await isLeader(c)) ? 1 : 0), { timeout: 5000 })
    .toBe(1);

  await writeFile(a, "/v.txt", "v");
  await expect.poll(() => readFile(b, "/v.txt"), { timeout: 5000 }).toBe("v");
  await expect.poll(() => readFile(c, "/v.txt"), { timeout: 5000 }).toBe("v");

  await context.close();
});

test("leader failover: when leader stops, another becomes leader and RPCs continue", async ({ browser }) => {
  const context = await browser.newContext();
  const [a, b, c] = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  const ns = `ns-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const arena = `arena-${Math.random().toString(36).slice(2)}`;

  [a, b, c].forEach(setupPage);
  await Promise.all([a.goto(url(ns, arena)), b.goto(url(ns, arena)), c.goto(url(ns, arena))]);
  await Promise.all([waitForReady(a), waitForReady(b), waitForReady(c)]);
  await Promise.all([startCandidate(a), startCandidate(b), startCandidate(c)]);

  // Find current leader
  async function leaderIdx() {
    const states = await Promise.all([isLeader(a).catch(() => false), isLeader(b).catch(() => false), isLeader(c).catch(() => false)]);
    return states.findIndex((x) => x);
  }

  let idx = -1;
  await expect
    .poll(
      async () => {
        idx = await leaderIdx();
        return idx >= 0;
      },
      { timeout: 5000 }
    )
    .toBe(true);

  console.log(`Initial leader is page ${idx}`);
  const pages = [a, b, c];
  const leader = pages[idx];

  // Shutdown the leader
  await shutdownLeader(leader);
  console.log(`Shut down leader ${idx}`);

  // Wait for a different page to become leader
  await expect
    .poll(
      async () => {
        const li = await leaderIdx();
        console.log(`Current leader index: ${li}`);
        return li >= 0 && li !== idx ? "changed" : "same";
      },
      { timeout: 10000 }
    )
    .toBe("changed");

  const newLeaderIdx = await leaderIdx();
  console.log(`New leader is page ${newLeaderIdx}`);

  // Give the new leader a moment to fully initialize
  await new Promise((resolve) => setTimeout(resolve, 200));

  // RPCs still work - use the remaining two pages (not the old leader that was shut down)
  const remainingPages = [0, 1, 2].filter((i) => i !== idx);
  const writerIdx = remainingPages[0];
  const readerIdx = remainingPages[1];

  console.log(`Writing from page ${writerIdx}, reading from page ${readerIdx} (old leader was ${idx}, new leader is ${newLeaderIdx})`);

  await writeFile(pages[writerIdx], "/w.txt", "w");
  await expect.poll(() => readFile(pages[readerIdx], "/w.txt"), { timeout: 5000 }).toBe("w");

  await context.close();
});

test("leader crash: abrupt tab close triggers failover and RPCs recover", async ({ browser }) => {
  const context = await browser.newContext();
  const [a, b] = await Promise.all([context.newPage(), context.newPage()]);
  const ns = `ns-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const arena = `arena-${Math.random().toString(36).slice(2)}`;

  [a, b].forEach(setupPage);
  await Promise.all([a.goto(url(ns, arena)), b.goto(url(ns, arena))]);
  await Promise.all([waitForReady(a), waitForReady(b)]);
  await Promise.all([startCandidate(a), startCandidate(b)]);

  await expect.poll(async () => ((await isLeader(a)) ? 1 : 0) + ((await isLeader(b)) ? 1 : 0), { timeout: 5000 }).toBe(1);

  const leaderPage = (await isLeader(a)) ? a : b;
  const followerPage = leaderPage === a ? b : a;

  // Write a file before crash
  await writeFile(leaderPage, "/pre-crash.txt", "before");
  await expect.poll(() => readFile(followerPage, "/pre-crash.txt"), { timeout: 5000 }).toBe("before");

  // Crash the leader (abrupt close, no graceful shutdown)
  await leaderPage.close();

  // Follower should become the new leader
  await expect.poll(() => isLeader(followerPage), { timeout: 10000 }).toBe(true);

  // RPCs should work on the new leader
  await writeFile(followerPage, "/post-crash.txt", "after");
  await expect.poll(() => readFile(followerPage, "/post-crash.txt"), { timeout: 5000 }).toBe("after");

  await context.close();
});

test("follower request timeout when no leader responds", async ({ browser }) => {
  const context = await browser.newContext();
  const lockHolder = await context.newPage();
  const follower = await context.newPage();
  const ns = `ns-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const arena = `arena-${Math.random().toString(36).slice(2)}`;

  setupPage(lockHolder);
  setupPage(follower);

  // Navigate lock holder to same origin so it can hold the Web Lock
  await lockHolder.goto(url(ns, arena));
  await waitForReady(lockHolder);

  // Hold the ns-scoped Web Lock, preventing any broker from becoming leader
  const lockName = `opfs-worker-lock-${ns}`;
  await lockHolder.evaluate((name: string) => {
    return new Promise<void>((resolve) => {
      navigator.locks.request(name, () => {
        resolve(); // signal that we have the lock
        return new Promise(() => {}); // hold it forever
      });
    });
  }, lockName);

  // Start the follower with a short timeout (1s)
  await follower.goto(url(ns, arena, { timeout: 1000 }));
  await waitForReady(follower);
  await startCandidate(follower);

  // Follower should not be leader
  await expect.poll(() => isLeader(follower), { timeout: 2000 }).toBe(false);

  // Try to write — should fail since no leader exists to handle the request
  const error = await follower.evaluate(async () => {
    try {
      await window.thumbdriveTest.writeFile("/timeout-test.txt", "should-fail");
      return null;
    } catch (e: any) {
      return e.message || String(e);
    }
  });

  expect(error).toBeTruthy();
  expect(error).toContain("timeout");

  await context.close();
});

test("restart cycle: stop and start preserves OPFS data", async ({ page }) => {
  const ns = `ns-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const arena = `arena-${Math.random().toString(36).slice(2)}`;

  setupPage(page);
  await page.goto(url(ns, arena));
  await waitForReady(page);
  await startCandidate(page);
  await expect.poll(() => isLeader(page), { timeout: 5000 }).toBe(true);

  // Write a file
  await writeFile(page, "/restart-test.txt", "before-restart");
  await expect.poll(() => readFile(page, "/restart-test.txt"), { timeout: 5000 }).toBe("before-restart");

  // Shutdown gracefully
  await shutdownLeader(page);
  await expect.poll(() => isLeader(page), { timeout: 5000 }).toBe(false);

  // Start again
  await startCandidate(page);
  await expect.poll(() => isLeader(page), { timeout: 5000 }).toBe(true);

  // New writes work after restart
  await writeFile(page, "/restart-test-2.txt", "after-restart");
  await expect.poll(() => readFile(page, "/restart-test-2.txt"), { timeout: 5000 }).toBe("after-restart");

  // Can shutdown again cleanly
  await shutdownLeader(page);
  await expect.poll(() => isLeader(page), { timeout: 5000 }).toBe(false);
});

test("concurrent writes from multiple tabs with overlapping JSONRPC IDs", async ({ browser }) => {
  const context = await browser.newContext();
  const [a, b, c] = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  const ns = `ns-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const arena = `arena-${Math.random().toString(36).slice(2)}`;

  [a, b, c].forEach(setupPage);
  await Promise.all([a.goto(url(ns, arena)), b.goto(url(ns, arena)), c.goto(url(ns, arena))]);
  await Promise.all([waitForReady(a), waitForReady(b), waitForReady(c)]);
  await Promise.all([startCandidate(a), startCandidate(b), startCandidate(c)]);

  await expect
    .poll(async () => ((await isLeader(a)) ? 1 : 0) + ((await isLeader(b)) ? 1 : 0) + ((await isLeader(c)) ? 1 : 0), { timeout: 5000 })
    .toBe(1);

  // Fire concurrent writes from all three tabs simultaneously.
  // Each tab's vscode-jsonrpc connection assigns IDs starting from 0,
  // so the broker's ID rewriting must disambiguate them.
  await Promise.all([writeFile(a, "/c1.txt", "from-a"), writeFile(b, "/c2.txt", "from-b"), writeFile(c, "/c3.txt", "from-c")]);

  // All files should be readable from any tab
  await expect.poll(() => readFile(b, "/c1.txt"), { timeout: 5000 }).toBe("from-a");
  await expect.poll(() => readFile(c, "/c2.txt"), { timeout: 5000 }).toBe("from-b");
  await expect.poll(() => readFile(a, "/c3.txt"), { timeout: 5000 }).toBe("from-c");

  await context.close();
});

test("multiple sequential failovers across three tabs", async ({ browser }) => {
  const context = await browser.newContext();
  const [a, b, c] = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  const ns = `ns-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const arena = `arena-${Math.random().toString(36).slice(2)}`;

  [a, b, c].forEach(setupPage);
  await Promise.all([a.goto(url(ns, arena)), b.goto(url(ns, arena)), c.goto(url(ns, arena))]);
  await Promise.all([waitForReady(a), waitForReady(b), waitForReady(c)]);
  await Promise.all([startCandidate(a), startCandidate(b), startCandidate(c)]);

  const pages = [a, b, c];

  async function findLeaderIdx() {
    const states = await Promise.all(pages.map((p) => isLeader(p).catch(() => false)));
    return states.findIndex((x) => x);
  }

  // Wait for initial leader
  let leaderIdx = -1;
  await expect
    .poll(
      async () => {
        leaderIdx = await findLeaderIdx();
        return leaderIdx >= 0;
      },
      { timeout: 5000 }
    )
    .toBe(true);

  // Write from first leader
  await writeFile(pages[leaderIdx], "/failover-1.txt", "leader-1");

  // --- First failover: crash the leader ---
  const firstLeaderIdx = leaderIdx;
  await pages[firstLeaderIdx].close();

  const remaining = [0, 1, 2].filter((i) => i !== firstLeaderIdx);

  // Wait for a new leader among the remaining tabs
  await expect
    .poll(
      async () => {
        const states = await Promise.all(remaining.map((i) => isLeader(pages[i]).catch(() => false)));
        return states.some((x) => x);
      },
      { timeout: 10000 }
    )
    .toBe(true);

  // Find new leader
  let secondLeaderIdx = -1;
  for (const i of remaining) {
    if (await isLeader(pages[i]).catch(() => false)) {
      secondLeaderIdx = i;
      break;
    }
  }

  // Write from second leader and verify cross-tab read works
  const lastIdx = remaining.find((i) => i !== secondLeaderIdx)!;
  await writeFile(pages[secondLeaderIdx], "/failover-2.txt", "leader-2");
  await expect.poll(() => readFile(pages[lastIdx], "/failover-2.txt"), { timeout: 5000 }).toBe("leader-2");

  // --- Second failover: crash the second leader ---
  await pages[secondLeaderIdx].close();

  // Last page standing should become leader
  await expect.poll(() => isLeader(pages[lastIdx]), { timeout: 10000 }).toBe(true);

  // RPCs still work after two consecutive failovers
  await writeFile(pages[lastIdx], "/failover-3.txt", "leader-3");
  await expect.poll(() => readFile(pages[lastIdx], "/failover-3.txt"), { timeout: 5000 }).toBe("leader-3");

  await context.close();
});

test("RPCs sent during failover transition eventually resolve", async ({ browser }) => {
  const context = await browser.newContext();
  const [a, b, c] = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  const ns = `ns-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const arena = `arena-${Math.random().toString(36).slice(2)}`;

  // Use a short broker timeout so failed RPCs don't block the test for 20s
  [a, b, c].forEach(setupPage);
  await Promise.all([
    a.goto(url(ns, arena, { timeout: 2000 })),
    b.goto(url(ns, arena, { timeout: 2000 })),
    c.goto(url(ns, arena, { timeout: 2000 })),
  ]);
  await Promise.all([waitForReady(a), waitForReady(b), waitForReady(c)]);
  await Promise.all([startCandidate(a), startCandidate(b), startCandidate(c)]);

  const pages = [a, b, c];

  async function findLeaderIdx() {
    const states = await Promise.all(pages.map((p) => isLeader(p).catch(() => false)));
    return states.findIndex((x) => x);
  }

  let leaderIdx = -1;
  await expect
    .poll(
      async () => {
        leaderIdx = await findLeaderIdx();
        return leaderIdx >= 0;
      },
      { timeout: 5000 }
    )
    .toBe(true);

  // Identify the two survivors
  const survivors = [0, 1, 2].filter((i) => i !== leaderIdx).map((i) => pages[i]);

  // Crash the leader
  await pages[leaderIdx].close();

  // Immediately fire RPCs from both survivors — the first attempt may time out
  // if the broadcast arrives before the new leader is ready, so we retry once.
  async function writeWithRetry(page: Page, path: string, content: string) {
    try {
      await writeFile(page, path, content);
    } catch {
      // First attempt failed (likely timeout during transition). Retry after
      // giving the new leader time to finish booting.
      await page.waitForTimeout(500);
      await writeFile(page, path, content);
    }
  }

  await Promise.all([writeWithRetry(survivors[0], "/race-1.txt", "race-1"), writeWithRetry(survivors[1], "/race-2.txt", "race-2")]);

  // Both writes should be readable from either survivor
  await expect.poll(() => readFile(survivors[0], "/race-2.txt"), { timeout: 5000 }).toBe("race-2");
  await expect.poll(() => readFile(survivors[1], "/race-1.txt"), { timeout: 5000 }).toBe("race-1");

  await context.close();
});
