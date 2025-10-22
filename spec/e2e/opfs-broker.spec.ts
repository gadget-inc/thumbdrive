import { test, expect, type Page } from "@playwright/test";

function url(ns: string, arena: string) {
  return `/testapp/index.html?ns=${encodeURIComponent(ns)}&arena=${encodeURIComponent(arena)}`;
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
  // Wait for the page to load and thumbdriveTest to be available
  await page.waitForFunction(() => window.thumbdriveTest !== undefined, { timeout: 10000 });
}

async function startCandidate(page: Page) {
  await page.evaluate(() => window.thumbdriveTest.start());
  // Give the worker time to initialize
  await page.waitForTimeout(100);
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
