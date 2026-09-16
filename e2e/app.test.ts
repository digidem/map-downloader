import fs from "fs";
import os from "os";
import path from "path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const fixturePath = path.resolve("e2e/fixtures/plain_1.mbtiles");
const baseUrl = "http://localhost:4174";

const chromiumArgs =
  process.platform === "darwin"
    ? ["--use-gl=angle", "--use-angle=metal"]
    : ["--use-gl=angle", "--use-angle=swiftshader"];

/** Open the picker to the .mbtiles tab and load a fixture. */
async function loadMbtilesFixture(page: Page) {
  await page.goto(baseUrl);
  await page.locator("#style-chip").waitFor({ state: "visible" });
  await page.locator("#style-chip").click();
  await page.locator('.sp-tab[data-tab="mbtiles"]').click();

  const dropTarget = page.locator(".sp-mbtiles-drop, .sp-mbtiles-btn").first();
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dropTarget.click(),
  ]);
  await fileChooser.setFiles(fixturePath);

  await page.waitForFunction(
    (name) =>
      document
        .querySelector("#style-chip .va-style-name")
        ?.textContent?.includes(name),
    "plain_1.mbtiles",
    { timeout: 30_000 },
  );
}

/** The download action stays disabled until a service worker controls the page.
 *  Playwright's Firefox drops the controller on navigation, so tests that are
 *  not about that gate set the flag themselves. */
async function markDownloadReady(page: Page) {
  await page.evaluate(() => {
    const modal = document.querySelector("download-modal") as any;
    if (modal) modal.downloadReady = true;
  });
}

/** Wait until the map has produced a bbox (bounds summary stops showing "—"),
 *  which means the download flow has a region to work with. */
async function waitForMapReady(page: Page) {
  await page.waitForFunction(() => {
    const s = document.querySelector(".bounds-summary");
    return !!s && s.textContent !== "—" && s.textContent !== "";
  });
}

function appTests(
  browserType: BrowserType,
  launchOptions?: Record<string, unknown>,
  opts?: {
    skipDownloadTest?: boolean;
    skipMbtilesTests?: boolean;
    skipRouteMocks?: boolean;
    persistent?: boolean;
  },
) {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let userDataDir: string | undefined;
  let page: Page;

  beforeAll(async () => {
    if (opts?.persistent) {
      // WebKit's ephemeral contexts have no OPFS, which the mbtiles path needs.
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "map-downloader-"));
      context = await browserType.launchPersistentContext(userDataDir, {
        headless: true,
        acceptDownloads: true,
        ...launchOptions,
      });
      page = context.pages()[0] ?? (await context.newPage());
    } else {
      browser = await browserType.launch({ headless: true, ...launchOptions });
      page = await browser.newPage();
    }
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test("renders the map downloader UI on load", async () => {
    await page.goto(baseUrl);
    await page.locator("#style-chip").waitFor({ state: "visible" });
    await page.locator("#download-button").waitFor({ state: "visible" });
    await page.locator(".va-brand").waitFor({ state: "visible" });
    expect(await page.locator(".bbox-handle").count()).toBe(8);
  });

  test("style picker lists presets and closes on selection", async () => {
    await page.goto(baseUrl);
    await page.locator("#style-chip").waitFor({ state: "visible" });
    await page.locator("#style-chip").click();
    await page.locator(".sp-preset-card").first().waitFor({ state: "visible" });
    expect(await page.locator(".sp-preset-card").count()).toBeGreaterThan(0);
    await page.locator(".sp-close").click();
    await page.locator(".sp-backdrop").waitFor({ state: "hidden" });
  });

  test("bounds panel exposes the four cardinal inputs", async () => {
    await page.goto(baseUrl);
    await page.locator(".bounds-toggle").waitFor({ state: "visible" });
    await page.locator(".bounds-toggle").click();
    expect(await page.locator(".bounds-input").count()).toBe(4);
  });

  test("help popover opens and closes", async () => {
    await page.goto(baseUrl);
    await page.locator(".help-btn").waitFor({ state: "visible" });
    await page.locator(".help-btn").click();
    await page.locator(".help-popover").waitFor({ state: "visible" });
    await page.locator(".help-popover-close").click();
    await page.locator(".help-popover").waitFor({ state: "hidden" });
  });

  test("attribution popover shows the active style", async () => {
    await page.goto(baseUrl);
    await page.locator(".attrib-btn").waitFor({ state: "visible" });
    await page.locator(".attrib-btn").click();
    await page.locator(".attrib-popover").waitFor({ state: "visible" });
    expect(await page.locator(".attrib-pill").count()).toBe(1);
    await page.locator(".attrib-popover-close").click();
    await page.locator(".attrib-popover").waitFor({ state: "hidden" });
  });

  test("bounds panel lock / unlock toggles the locked state", async () => {
    await page.goto(baseUrl);
    await waitForMapReady(page);
    await page.locator(".bounds-toggle").click();
    const lockBtn = page.locator(".bounds-lock-btn");
    await lockBtn.waitFor({ state: "visible" });
    expect((await lockBtn.textContent())?.includes("Lock bounds")).toBe(true);

    await lockBtn.click();
    expect((await lockBtn.textContent())?.includes("Unlock")).toBe(true);
    expect(
      await page.locator(".bbox-map-overlay.bbox-locked").count(),
    ).toBe(1);
    // Resize handles are disabled while locked.
    expect(await page.locator(".bbox-handle").first().isVisible()).toBe(false);

    await lockBtn.click();
    expect(
      await page.locator(".bbox-map-overlay.bbox-locked").count(),
    ).toBe(0);
    expect(await page.locator(".bbox-handle").first().isVisible()).toBe(true);
  });

  test("restrictive style gates download behind licence acknowledgement", async () => {
    await page.goto(baseUrl);
    await page.locator("#style-chip").waitFor({ state: "visible" });
    await waitForMapReady(page);
    await page.locator("#style-chip").click();
    await page
      .locator(".sp-preset-card", { hasText: "Esri Satellite" })
      .first()
      .click();
    await page.locator(".sp-backdrop").waitFor({ state: "hidden" });

    await markDownloadReady(page);
    await page.locator("#download-button").click();
    await page.locator(".dm-primary").waitFor({ state: "visible" });
    // Restrictive licence ⇒ banner shown, primary disabled until acknowledged.
    await page.locator(".dm-licence").waitFor({ state: "visible" });
    expect(await page.locator(".dm-primary").isDisabled()).toBe(true);

    await page.locator(".dm-licence-checkbox").check();
    await page
      .locator(".dm-primary:not([disabled])")
      .waitFor({ state: "visible" });
    expect(await page.locator(".dm-primary").isEnabled()).toBe(true);
  });

  test("huge download requires a typed-size confirmation", async () => {
    await page.goto(baseUrl);
    // Start from a clean slate — a prior test may have persisted a restrictive
    // style, which would gate the download behind the licence checkbox.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.locator("#style-chip").waitFor({ state: "visible" });
    await waitForMapReady(page);
    // Zoom right out so the bbox covers a huge area → huge tile estimate.
    await page.evaluate(() => (window as any).maplibreMap?.setZoom(1));
    await page.waitForTimeout(600);

    await markDownloadReady(page);
    await page.locator("#download-button").click();
    await page.locator(".dm-primary").waitFor({ state: "visible" });
    // Give the async max-zoom resolve a moment to settle.
    await page.waitForTimeout(1200);
    const primary = page.locator(".dm-primary");
    expect((await primary.textContent())?.includes("Review & download")).toBe(
      true,
    );

    await primary.click();
    await page.locator(".dm-huge-modal").waitFor({ state: "visible" });
    expect(await page.locator(".dm-huge-confirm").isDisabled()).toBe(true);

    // Typing the displayed size in MB enables the override button.
    const sizeText =
      (await page.locator(".dm-huge-stat-size").textContent()) ?? "";
    const mb = sizeText.replace(/[^0-9]/g, "");
    expect(mb.length).toBeGreaterThan(0);
    await page.locator(".dm-huge-input").fill(mb);
    await page
      .locator(".dm-huge-confirm:not([disabled])")
      .waitFor({ state: "visible" });
    expect(await page.locator(".dm-huge-confirm").isEnabled()).toBe(true);

    // Cancel backs out without starting the download.
    await page.locator(".dm-huge-cancel").click();
    await page.locator(".dm-huge-modal").waitFor({ state: "hidden" });
  });

  const testMbtiles = opts?.skipMbtilesTests ? test.skip : test;
  testMbtiles("opens an mbtiles file via the style picker", async () => {
    await loadMbtilesFixture(page);
    const canvas = page.locator("#map canvas").first();
    expect(await canvas.count()).toBeGreaterThan(0);
  });

  testMbtiles("opens an mbtiles file via drag and drop", async () => {
    await page.goto(baseUrl);
    await page.locator("#style-chip").waitFor({ state: "visible" });

    const buffer = await import("fs").then((fs) =>
      fs.readFileSync(fixturePath),
    );
    await page.evaluate(
      async ({ bytes, fileName }) => {
        const uint8 = new Uint8Array(bytes);
        const file = new File([uint8], fileName);
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        document.dispatchEvent(
          new DragEvent("dragenter", { dataTransfer, bubbles: true }),
        );
        document.dispatchEvent(
          new DragEvent("drop", { dataTransfer, bubbles: true }),
        );
      },
      { bytes: Array.from(buffer), fileName: "plain_1.mbtiles" },
    );
    await page.waitForFunction(
      (name) =>
        document
          .querySelector("#style-chip .va-style-name")
          ?.textContent?.includes(name),
      "plain_1.mbtiles",
      { timeout: 30_000 },
    );
  });

  testMbtiles("can pan the map by dragging", async () => {
    await loadMbtilesFixture(page);
    const canvas = page.locator("#map canvas").first();
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    const centerBefore = await page.evaluate(
      () => (window as any).maplibreMap?.getCenter(),
    );
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 100, startY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const centerAfter = await page.evaluate(
      () => (window as any).maplibreMap?.getCenter(),
    );
    expect(centerAfter.lng).not.toBeCloseTo(centerBefore.lng, 1);
  });

  // Playwright's WebKit does not route requests that pass through a controlling
  // service worker, so these API mocks are bypassed there and the test would
  // hit the real Mapbox API. The behaviour is engine-independent URL parsing.
  const testRouteMock = opts?.skipRouteMocks ? test.skip : test;

  testRouteMock("accepts each form of Mapbox style share link", async () => {
    const token = "pk.test-token";
    const styleBase = "api.mapbox.com/styles/v1/someone/abc123";
    const requested: string[] = [];
    await page.route("https://api.mapbox.com/**", (route) => {
      const url = route.request().url();
      requested.push(url);
      if (url.includes("/styles/v1/someone/abc123?")) {
        return route.fulfill({
          json: {
            version: 8,
            name: "Test Satellite",
            sources: {
              composite: { type: "vector", url: "mapbox://test.tiles" },
            },
            layers: [{ id: "bg", type: "background" }],
          },
        });
      }
      if (url.includes("/v4/test.tiles.json")) {
        return route.fulfill({
          json: {
            tilejson: "2.2.0",
            tiles: [],
            maxzoom: 14,
            attribution:
              '<a href="https://example.com/data" onclick="x()">© Data</a> ' +
              '<img src="x" onerror="x()"><a href="javascript:x()">© Imagery</a>' +
              '<script>x()</script> <a href="https://example.com/data">© Data</a>',
          },
        });
      }
      return route.fulfill({ status: 404 });
    });

    const cases = [
      { url: "mapbox://styles/someone/abc123", needsToken: true },
      {
        url: `https://${styleBase}/wmts?access_token=${token}`,
        needsToken: false,
      },
      {
        url: `https://${styleBase}.html?title=view&access_token=${token}&fresh=true#13/33.7/-118.4`,
        needsToken: false,
      },
    ];
    try {
      for (const c of cases) {
        // A persisted Mapbox selection would make MapLibre skip refetching
        // the source when the same style is picked again.
        await page.goto(baseUrl);
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await page.locator("#style-chip").click();
        await page.locator('.sp-tab[data-tab="custom"]').click();
        await page.locator(".sp-url").fill(c.url);
        expect(await page.locator(".sp-token-input").count()).toBe(
          c.needsToken ? 1 : 0,
        );
        if (c.needsToken) await page.locator(".sp-token-input").fill(token);
        requested.length = 0;
        await page.locator(".sp-validate-btn").click();
        await page.waitForFunction(
          () =>
            document
              .querySelector("#style-chip .va-style-name")
              ?.textContent?.includes("Test Satellite"),
        );
        expect(requested).toContain(
          `https://${styleBase}?access_token=${token}`,
        );
        // The picker (for attribution) and MapLibre each resolve the style's
        // mapbox:// source through the API.
        await expect
          .poll(
            () =>
              requested.filter(
                (u) =>
                  u.includes("/v4/test.tiles.json") &&
                  u.includes(`access_token=${token}`),
              ).length,
          )
          .toBeGreaterThanOrEqual(2);
      }

      // The acknowledgement names Mapbox and links to its terms, not the URL.
      await page.locator("#download-button").click();
      const terms = page.locator(".dm-licence-terms");
      await terms.waitFor({ state: "visible" });
      expect(await terms.textContent()).toBe("Mapbox's terms of use");
      expect(await terms.getAttribute("href")).toBe(
        "https://www.mapbox.com/legal/tos",
      );

      // A reload restores the selection from Recents under the same name.
      await page.reload();
      await page.waitForFunction(
        () =>
          document
            .querySelector("#style-chip .va-style-name")
            ?.textContent === "Test Satellite",
      );

      // Source attribution is reduced to text and http(s) links, deduplicated.
      await page.locator(".attrib-btn").click();
      const box = page.locator(".attrib-popover-box");
      await box.waitFor({ state: "visible" });
      expect(
        await box.evaluate((el) => el.innerHTML.replace(/<!--.*?-->/g, "").trim()),
      ).toBe(
        '<a href="https://example.com/data" target="_blank" rel="noopener noreferrer">© Data</a> © Imagery',
      );
    } finally {
      // Later tests would otherwise restore this style and hit the real API.
      await page.evaluate(() => localStorage.clear());
      await page.unroute("https://api.mapbox.com/**");
    }
  });

  const testDownload =
    opts?.skipDownloadTest || opts?.skipMbtilesTests ? test.skip : test;
  testDownload("can download mbtiles as smp file", { timeout: 90_000 }, async () => {
    await loadMbtilesFixture(page);

    // Force the service-worker streaming path so the test captures the download.
    await page.evaluate(async () => {
      delete (window as any).showSaveFilePicker;
      await navigator.serviceWorker.ready;
    });

    await page.locator("#download-button").click();
    await page.locator(".dm-primary").waitFor({ state: "visible" });

    // Pull the slider down to a small zoom so the tile-count estimate stays
    // below the hard warning threshold for the global default bbox.
    await page.evaluate(() => {
      const slider = document.querySelector(
        ".dm-zoom-slider",
      ) as HTMLInputElement;
      slider.value = "2";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(300);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.locator(".dm-primary").click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.smp$/);

    const readable = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of readable) {
      chunks.push(Buffer.from(chunk));
    }
    const fileContents = Buffer.concat(chunks);
    // SMP files are zip archives — verify the zip magic number (PK\x03\x04)
    expect(fileContents[0]).toBe(0x50);
    expect(fileContents[1]).toBe(0x4b);
    expect(fileContents.length).toBeGreaterThan(100);
  });
}

describe("chromium", () => {
  appTests(chromium, {
    args: ["--ignore-gpu-blocklist", "--enable-webgl", ...chromiumArgs],
  });
});

const describeFirefox = process.env.CI ? describe.skip : describe;
describeFirefox("firefox", () => {
  appTests(firefox, undefined, { skipDownloadTest: true });
});

// WebKit is the engine Safari ships. It only supports COEP `require-corp`, so
// under the app's `credentialless` headers it has no SharedArrayBuffer and
// sqlite-wasm cannot open an .mbtiles file — those tests are skipped. The
// streaming download path is covered by the service worker test below.
describe("webkit", () => {
  appTests(webkit, undefined, {
    persistent: true,
    skipMbtilesTests: true,
    skipRouteMocks: true,
  });
});

// Regression test for downloads clicked before the service worker controls the
// page: the action must stay unavailable rather than hang waiting for a stream
// nobody reads.
describe("without a service worker", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ["--ignore-gpu-blocklist", "--enable-webgl", ...chromiumArgs],
    });
  });

  afterAll(async () => {
    await browser?.close();
  });

  test("the download button stays disabled", async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      await page.goto(baseUrl);
      await page.locator("#style-chip").waitFor({ state: "visible" });
      await waitForMapReady(page);
      await page.locator("#download-button").click();
      const primary = page.locator(".dm-primary");
      await primary.waitFor({ state: "visible" });
      expect(await primary.isDisabled()).toBe(true);
      expect((await primary.textContent())?.trim()).toBe("Preparing download…");
    } finally {
      await context.close();
    }
  });
});

/** Exercises public/sw.js the way the page does: navigate to a unique
 *  /_download/ URL first, wait for the worker to announce the request, then
 *  hand it the stream. The app's own download needs an .mbtiles file, which
 *  WebKit cannot open, so this covers the streaming path there. */
function serviceWorkerDownloadTest(
  browserType: BrowserType,
  opts?: { launchOptions?: Record<string, unknown>; persistent?: boolean },
) {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let userDataDir: string | undefined;
  let page: Page;

  beforeAll(async () => {
    if (opts?.persistent) {
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "map-downloader-"));
      context = await browserType.launchPersistentContext(userDataDir, {
        headless: true,
        acceptDownloads: true,
        ...opts?.launchOptions,
      });
      page = context.pages()[0] ?? (await context.newPage());
    } else {
      browser = await browserType.launch({
        headless: true,
        ...opts?.launchOptions,
      });
      page = await browser.newPage();
    }
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test("streams a download through the service worker", async () => {
    await page.goto(baseUrl);
    await page.locator("#style-chip").waitFor({ state: "visible" });

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        const sw = registration.active ?? navigator.serviceWorker.controller;
        if (!sw) throw new Error("no active service worker");

        const fileName = "sw stream test.smp";
        const encodedName = encodeURIComponent(fileName);
        const url = `${location.origin}/_download/${crypto.randomUUID()}/${encodedName}`;

        const announced = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5000);
          navigator.serviceWorker.addEventListener("message", (event) => {
            if (
              event.data?.type === "downloadStarted" &&
              event.data.url === url
            ) {
              clearTimeout(timer);
              resolve(true);
            }
          });
        });

        const iframe = document.createElement("iframe");
        iframe.hidden = true;
        iframe.src = url;
        document.body.appendChild(iframe);

        if (!(await announced)) {
          throw new Error("service worker never saw the download request");
        }

        const channel = new MessageChannel();
        // Same message protocol as the worker's MessagePortSource: it asks for
        // a chunk, we answer with one, then close.
        const chunks = [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00])];
        let next = 0;
        channel.port2.onmessage = () => {
          if (next < chunks.length) {
            channel.port2.postMessage({ type: 0, chunk: chunks[next++] });
          } else {
            channel.port2.postMessage({ type: 2 });
          }
        };
        sw.postMessage(
          {
            url,
            headers: {
              // Safari ignores filename*, so an ASCII filename is sent too.
              "content-disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodedName}`,
              "content-type": "application/octet-stream",
            },
            readablePort: channel.port1,
          },
          [channel.port1],
        );
      }),
    ]);

    // A worker that ignored the request would leave the navigation to the
    // server, which answers unknown paths with index.html.
    expect(download.suggestedFilename()).toMatch(/\.smp$/);

    const readable = await download.createReadStream();
    const received: Buffer[] = [];
    for await (const chunk of readable) received.push(Buffer.from(chunk));
    expect(Buffer.concat(received)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00]),
    );
  });
}

describe("chromium service worker download", () => {
  serviceWorkerDownloadTest(chromium, {
    launchOptions: {
      args: ["--ignore-gpu-blocklist", "--enable-webgl", ...chromiumArgs],
    },
  });
});

describe("webkit service worker download", () => {
  serviceWorkerDownloadTest(webkit, { persistent: true });
});
