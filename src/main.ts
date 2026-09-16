import "maplibre-gl/dist/maplibre-gl.css";
import pDefer, { type DeferredPromise } from "p-defer";
import {
  addProtocol,
  setWorkerUrl,
  type StyleSpecification,
} from "maplibre-gl";
// `?worker&url`, not `?url`: the worker imports a sibling shared chunk that `?url` doesn't emit.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

import {
  PRESET_STYLES,
  isTileUrlTemplate,
  rasterStyleForTileUrl,
  type AppStyle,
  type MbtilesStyle,
} from "./preset-styles.ts";
import { BboxMap, type GeoBbox } from "./bbox-map.ts";
import { BoundsPanel } from "./bounds-panel.ts";
import { AttributionButton } from "./attribution-button.ts";
import { combineAttributions } from "./attribution.ts";
import { mapboxAccessToken } from "./mapbox.ts";
import { HelpButton } from "./help-button.ts";
import { StylePicker } from "./style-picker.ts";
import { DownloadModal, type DownloadController } from "./download-modal.ts";
import { OverlayPanel } from "./overlay-panel.ts";
import { isGeoJSONFile } from "./overlay-model.ts";
import { layerStyles } from "./layer-styles.ts";
import createProtocolHandler from "./protocol-handler.ts";
import {
  initAnalytics,
  styleProps,
  track,
} from "./analytics.ts";
import {
  loadRecents,
  customStyleFromRecent,
  loadSelected,
  recentIdForUrl,
  saveSelected,
} from "./recents-store.ts";

initAnalytics();

// ── Service worker (streaming downloads only, no offline caching) ─────────
if ("serviceWorker" in navigator) {
  // `updateViaCache: 'none'` bypasses the browser's 24h HTTP-cache rule for sw.js.
  navigator.serviceWorker
    .register("/sw.js", { updateViaCache: "none" })
    .then((registration) => registration.update())
    .catch((err) => console.warn("SW registration failed", err));
  // Messages from the worker are queued until the page asks for them, and the
  // download handshake below listens with addEventListener.
  navigator.serviceWorker.startMessages();
  void ensureDownloadWorker();
}

// Tile protocol for the current mbtiles file.
const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});
setWorkerUrl(maplibreWorkerUrl);
addProtocol("mbtiles", createProtocolHandler(getTileFromWorker));

// ── Worker tile request plumbing (for the mbtiles:// protocol) ────────────
const pendingTileRequests = new Map<number, DeferredPromise<ArrayBuffer>>();
let tileReqId = 0;

worker.addEventListener("message", (event) => {
  const data = event.data;
  if (typeof data?.id === "number" && pendingTileRequests.has(data.id)) {
    const deferred = pendingTileRequests.get(data.id)!;
    pendingTileRequests.delete(data.id);
    if (data.error) deferred.reject(new Error(data.error));
    else deferred.resolve(data.payload);
  }
});

function getTileFromWorker({
  z,
  x,
  y,
}: {
  z: number;
  x: number;
  y: number;
}): Promise<ArrayBuffer> {
  const id = tileReqId++;
  const deferred = pDefer<ArrayBuffer>();
  pendingTileRequests.set(id, deferred);
  worker.postMessage({ type: "tileRequest", payload: { z, x, y }, id });
  return deferred.promise;
}

window.addEventListener("beforeunload", () => {
  worker.postMessage({ type: "beforeunload" });
});

// ── App state ────────────────────────────────────────────────────────────
const mapHost = document.getElementById("map")!;
const overlayHost = document.getElementById("map-overlay")!;

const isMobile = () => window.matchMedia("(max-width: 640px)").matches;
const MOBILE_BOTTOM_INSET = 240;

/** Restore the persisted selection (or fall back to the first preset). mbtiles
 *  selections are not persisted — the underlying file is OPFS-scoped. */
function initialStyle(): AppStyle {
  const ref = loadSelected();
  if (ref?.kind === "preset") {
    const found = PRESET_STYLES.find((p) => p.id === ref.id);
    if (found) return found;
  }
  if (ref?.kind === "recent") {
    const recent = loadRecents().find((r) => r.id === ref.id);
    if (recent) return customStyleFromRecent(recent);
  }
  return PRESET_STYLES[0];
}

let currentStyle: AppStyle = initialStyle();
let currentGeoBbox: GeoBbox | null = null;
let currentMapZoom = 2;

const bboxMap = new BboxMap({
  container: mapHost,
  initialStyle: currentStyle,
  initialCenter: [-0.118, 51.509],
  initialZoom: 10,
  enableResize: !isMobile(),
  bboxColor: "yellow",
  bottomInset: isMobile() ? MOBILE_BOTTOM_INSET : 0,
  onBboxChange: (g) => {
    currentGeoBbox = g;
    boundsPanel.setGeoBbox(g);
  },
  onMapStateChange: ({ zoom }) => {
    currentMapZoom = zoom;
  },
});
(window as any).maplibreMap = bboxMap.map;

// ── Brand chip + help button ──────────────────────────────────────────────
const brand = document.createElement("div");
brand.className = "va-brand";
brand.innerHTML =
  '<img class="va-brand-mark" src="/logo.svg" alt="" /> Map Downloader';
overlayHost.appendChild(brand);

// Top-right controls: attribution "i" stacked above Help in a vertical column.
const topRight = document.createElement("div");
topRight.className = "va-top-right";
overlayHost.appendChild(topRight);

const attribution = new AttributionButton();
const help = new HelpButton();
attribution.init({
  onOpen: () => {
    help.close();
    track("info_panel_open", { panel: "attribution" });
  },
});
help.init({
  onOpen: () => {
    attribution.close();
    track("info_panel_open", { panel: "help" });
  },
});
topRight.appendChild(attribution.el);
topRight.appendChild(help.el);
attribution.setStyle(currentStyle);

// ── Overlays (GeoJSON layers, desktop only) ───────────────────────────────
// `new` (not createElement) so the import is a value reference the bundler
// keeps, preserving the customElements.define side-effect.
const overlayPanel = new OverlayPanel();
overlayPanel.init({ map: bboxMap.map, isMobile });
overlayHost.appendChild(overlayPanel.el);

// ── Bottom action card ────────────────────────────────────────────────────
const card = document.createElement("div");
card.className = "va-card";
overlayHost.appendChild(card);

const cardRow = document.createElement("div");
cardRow.className = "va-card-row";
card.appendChild(cardRow);

const styleChip = document.createElement("button");
styleChip.id = "style-chip";
styleChip.className = "va-style-chip";
styleChip.innerHTML = `
  <span class="va-style-thumb"></span>
  <span class="va-style-text">
    <span class="va-style-label">Style</span>
    <span class="va-style-name"></span>
  </span>
  <svg class="va-style-chev" width="10" height="10" viewBox="0 0 10 10" fill="none"
    stroke="currentColor" stroke-width="1.5"><path d="M2 4l3 3 3-3" /></svg>`;
cardRow.appendChild(styleChip);

const downloadBtn = document.createElement("button");
downloadBtn.id = "download-button";
downloadBtn.className = "va-download-btn";
downloadBtn.innerHTML = `
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 1v8M3 6l4 4 4-4M2 12h10" />
  </svg>
  Download`;
cardRow.appendChild(downloadBtn);

// When the bounds are locked, the bbox is anchored to these geo coords and
// follows the map on screen; input edits flow straight into the locked extent.
let lockedBounds: GeoBbox | null = null;
const boundsPanel = new BoundsPanel();
boundsPanel.init({
  onApply: (next) => {
    track("bounds_edit", { is_locked: lockedBounds != null });
    // After an inputs-driven edit, settle the map onto the new bbox the same
    // way a mouse resize does.
    if (lockedBounds) {
      lockedBounds = bboxMap.setLockedGeoBbox(next) ?? next;
      bboxMap.refitToBbox();
      return lockedBounds;
    }
    const result = bboxMap.setGeoBboxExact(next);
    bboxMap.refitToBbox();
    return result;
  },
  getMinGeoSpan: () => bboxMap.getMinGeoSpan(),
  onLock: () => {
    const geo = bboxMap.lockBounds();
    if (!geo) return;
    track("bounds_lock");
    lockedBounds = geo;
    currentGeoBbox = geo;
    boundsPanel.setLocked(true);
    boundsPanel.setGeoBbox(geo);
  },
  onUnlock: () => {
    bboxMap.unlockAndRefit();
    lockedBounds = null;
    boundsPanel.setLocked(false);
    boundsPanel.collapse();
  },
});
card.appendChild(boundsPanel.el);

function updateStyleChip() {
  const thumb = styleChip.querySelector(".va-style-thumb") as HTMLElement;
  const name = styleChip.querySelector(".va-style-name") as HTMLElement;
  name.textContent = currentStyle.name;
  thumb.style.background = thumbColor(currentStyle.id);
}
updateStyleChip();

function thumbColor(id: string): string {
  const colors: Record<string, string> = {
    positron: "#dadad4",
    liberty: "#cfe2c8",
    bright: "#ffd560",
    dark: "#2a2f3a",
    fiord: "#45516e",
    satellite: "#1a3b5c",
    "esri-clarity": "#1f3a52",
    sentinel2: "#1f2c3a",
    nimbo: "#152a4c",
    "glad-landsat": "#1f2a40",
    topo: "#a8c890",
    "esri-topo": "#cdb98c",
    hillshade: "#bfbfbf",
    "esri-shaded-relief": "#b39764",
    "esri-terrain-base": "#c9d9b0",
    "esri-natgeo": "#d4a86a",
    cyclosm: "#f3eee0",
    humanitarian: "#f6d7c1",
    custom: "#aaa",
    mbtiles: "#e8b070",
  };
  return colors[id] ?? "#ccc";
}

// ── Style picker ──────────────────────────────────────────────────────────
// `new` (not createElement) so the StylePicker import is a value reference —
// otherwise the bundler drops it and its customElements.define side-effect.
const stylePicker = new StylePicker();
stylePicker.init({
  onSelectStyle: (s) => {
    track("style_select", styleProps(s));
    setStyle(s);
  },
  onSelectMbtiles: (file) => loadMbtilesFile(file, "picker"),
  isMobile,
});
overlayHost.appendChild(stylePicker.el);
styleChip.addEventListener("click", () => {
  track("style_picker_open");
  const c = bboxMap.map.getCenter();
  stylePicker.open(currentStyle.id, [c.lng, c.lat]);
});

// ── Download modal ────────────────────────────────────────────────────────
const downloadModal = new DownloadModal();
downloadModal.init({
  isMobile,
  onDownload: (req, callbacks) => startDownload(req, callbacks),
});
overlayHost.appendChild(downloadModal.el);
// Downloads stream through the service worker, which doesn't control the page
// for the first moments of a first visit; clicking before then cannot work.
downloadModal.downloadReady = !!navigator.serviceWorker?.controller;
navigator.serviceWorker?.addEventListener(
  "controllerchange",
  () => {
    downloadModal.downloadReady = true;
  },
  { once: true },
);
downloadBtn.addEventListener("click", () => {
  // currentGeoBbox is populated as soon as the map first lays out; if a click
  // beats that race, fall back to whatever the map can derive right now.
  const bbox = currentGeoBbox ?? bboxMap.getGeoBbox();
  if (!bbox) return;
  downloadModal.open({
    style: currentStyle,
    geoBbox: bbox,
    currentMapZoom,
  });
});

// ── Style switching ───────────────────────────────────────────────────────
function setStyle(style: AppStyle) {
  currentStyle = style;
  updateStyleChip();
  attribution.setStyle(style);
  bboxMap.setStyle(style);
  persistSelected(style);
}

function persistSelected(style: AppStyle) {
  if ("isMbtiles" in style && style.isMbtiles) {
    // Don't persist mbtiles — OPFS file is gone after reload.
    saveSelected(null);
    return;
  }
  if (style.id.startsWith("qms-")) {
    // QMS styles aren't persisted — the catalogue isn't available at boot.
    saveSelected(null);
    return;
  }
  if (style.id === "custom") {
    saveSelected({ kind: "recent", id: recentIdForUrl(style.url) });
  } else {
    saveSelected({ kind: "preset", id: style.id });
  }
}

// ── MBTiles flow ──────────────────────────────────────────────────────────
async function loadMbtilesFile(file: File, via: "picker" | "drop") {
  const metaP = new Promise<Record<string, any>>((resolve) => {
    const h = (event: MessageEvent) => {
      if (event.data?.type === "metadata") {
        worker.removeEventListener("message", h);
        resolve(event.data.payload);
      }
    };
    worker.addEventListener("message", h);
  });
  worker.postMessage({ type: "file", payload: file });
  const metadata = await metaP;
  const isVector = metadata.format === "pbf";

  const sources: StyleSpecification["sources"] = {
    mbtiles: {
      type: isVector ? "vector" : "raster",
      tiles: ["mbtiles://./{z}/{x}/{y}"],
      tileSize: isVector ? 512 : 256,
      bounds: metadata.bounds,
      minzoom: metadata.minzoom,
      maxzoom: metadata.maxzoom,
    },
  };

  const layers: StyleSpecification["layers"] = isVector
    ? [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#fafafa" },
        },
        ...layerStyles(metadata.vector_layers || []),
      ]
    : [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#222" },
        },
        { id: "mbtiles", type: "raster", source: "mbtiles" },
      ];

  const spec: StyleSpecification = {
    version: 8,
    sources,
    layers,
  };

  const mbtilesStyle: MbtilesStyle = {
    id: "mbtiles",
    name: file.name,
    desc: "Local .mbtiles file",
    url: "mbtiles://./",
    kind: isVector ? "vector" : "raster",
    isMbtiles: true,
    spec,
    maxZoom:
      typeof metadata.maxzoom === "number" ? metadata.maxzoom : undefined,
    attribution:
      (typeof metadata.attribution === "string" &&
        combineAttributions([metadata.attribution])) ||
      "Local .mbtiles file.",
    license: "open",
  };
  track("style_select", {
    ...styleProps(mbtilesStyle),
    via,
    tile_format: String(metadata.format ?? "unknown"),
    file_size_bytes: file.size,
  });
  setStyle(mbtilesStyle);
  if (Array.isArray(metadata.bounds) && metadata.bounds.length === 4) {
    bboxMap.fitBounds(
      [
        [metadata.bounds[0], metadata.bounds[1]],
        [metadata.bounds[2], metadata.bounds[3]],
      ],
      false,
    );
  }
}

// ── Download orchestration ────────────────────────────────────────────────
function startDownload(
  req: {
    style: AppStyle;
    bbox: GeoBbox;
    maxZoom: number;
    name: string;
    description: string;
  },
  callbacks: {
    onProgress: (p: { fraction: number; done?: boolean }) => void;
    onError: (msg: string) => void;
  },
): DownloadController {
  let cancelled = false;
  const fileName =
    (req.name.replace(/[^a-z0-9-_ ]/gi, "_").trim() || "map") + ".smp";

  (async () => {
    let cleanup: (() => void) | undefined;
    try {
      const channel = await prepareSwDownload(fileName);
      cleanup = channel.cleanup;

      // Build progress + completion handlers attached to the worker.
      const onComplete = waitForSmpComplete(
        (fraction) => {
          if (!cancelled) callbacks.onProgress({ fraction });
        },
        (err) => {
          if (!cancelled) callbacks.onError(err);
        },
      );

      const style = req.style;
      if ("isMbtiles" in style && style.isMbtiles) {
        worker.postMessage(
          { type: "generateSmpFromMbtiles", port: channel.workerPort },
          [channel.workerPort],
        );
      } else {
        // Other providers' keys are already in the URL; only a Mapbox token
        // is handed to the downloader, which sends it to api.mapbox.com.
        const accessToken = mapboxAccessToken(style);
        const message: any = {
          type: "generateSmpFromStyle",
          port: channel.workerPort,
          bbox: [
            req.bbox.west,
            req.bbox.south,
            req.bbox.east,
            req.bbox.north,
          ],
          maxZoom: req.maxZoom,
          accessToken,
        };
        const inlineSpec = "spec" in style && style.spec ? style.spec : null;
        if (inlineSpec) {
          message.styleSpec = inlineSpec;
        } else if (isTileUrlTemplate(style.url)) {
          // Tile URL template — wrap into a basic raster style, carrying the
          // source's subdomains, tile scheme (xyz/tms) and native max zoom to
          // the downloader so it never fetches overzoomed tiles.
          message.styleSpec = rasterStyleForTileUrl(
            style.url,
            "subdomains" in style ? style.subdomains : undefined,
            "scheme" in style ? style.scheme : undefined,
            "maxZoom" in style ? style.maxZoom : undefined,
          );
        } else {
          message.styleUrl = style.url;
        }
        worker.postMessage(message, [channel.workerPort]);
      }

      await onComplete;
      if (!cancelled) callbacks.onProgress({ fraction: 1, done: true });
    } catch (err) {
      if (!cancelled) callbacks.onError((err as Error).message);
    } finally {
      cleanup?.();
    }
  })();

  return {
    cancel() {
      cancelled = true;
    },
  };
}

interface SwDownloadChannel {
  workerPort: MessagePort;
  /** Removes the iframe that started the download. */
  cleanup: () => void;
}

// Kept in step with public/sw.js: an older worker ignores /_download/ requests.
const DOWNLOAD_PATH = "/_download/";
const DOWNLOAD_PROTOCOL = 1;

/** Ask the active service worker which download protocol it speaks (0 = none) */
function downloadProtocol(registration: ServiceWorkerRegistration) {
  return new Promise<number>((resolve) => {
    const sw = registration.active;
    if (!sw) return resolve(0);
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(0), 1000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data?.downloadProtocol ?? 0);
    };
    sw.postMessage({ type: "ping" }, [channel.port2]);
  });
}

/** A worker installed before the download path existed silently ignores those
 *  requests, and the page only finds out when a download fails, so replace it
 *  up front. */
async function ensureDownloadWorker() {
  const registration = await navigator.serviceWorker?.ready;
  if (!registration) return;
  if ((await downloadProtocol(registration)) >= DOWNLOAD_PROTOCOL) return;
  await registration.update().catch(() => {});
}

/** Resolves once the service worker reports it received the download request */
function waitForDownloadStart(url: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (started: boolean) => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(started);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "downloadStarted" && event.data.url === url) {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), timeout);
    navigator.serviceWorker.addEventListener("message", onMessage);
  });
}

/** Start the browser download and return the port the SMP stream writes to. */
async function prepareSwDownload(fileName: string): Promise<SwDownloadChannel> {
  if (!navigator.serviceWorker?.controller) {
    throw new Error(
      "Downloads need the service worker — reload the page and try again",
    );
  }

  const encodedName = encodeURIComponent(fileName)
    .replace(
      /['()]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    )
    .replace(/\*/g, "%2A");
  const url = `${location.origin}${DOWNLOAD_PATH}${crypto.randomUUID()}/${encodedName}`;

  // Navigate first and synchronously, before any await: Safari only starts a
  // download while the click's user activation is live. The service worker
  // holds the request open until the stream below reaches it.
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.src = url;
  document.body.appendChild(iframe);
  const cleanup = () => iframe.remove();

  // Nothing is generated until the request is known to have arrived.
  if (!(await waitForDownloadStart(url, 5000))) {
    cleanup();
    throw new Error(
      "The service worker did not receive the download request — reload the page and try again",
    );
  }

  const registration = await navigator.serviceWorker.ready;
  const sw = registration.active ?? navigator.serviceWorker.controller;
  if (!sw) {
    cleanup();
    throw new Error("Service worker not available");
  }

  const asciiName = fileName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const headers = {
    // Safari ignores filename*, so send a plain ASCII filename as well.
    "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    "content-type": "application/octet-stream",
  };
  const channel = new MessageChannel();
  sw.postMessage({ url, headers, readablePort: channel.port1 }, [
    channel.port1,
  ]);

  return { workerPort: channel.port2, cleanup };
}

function waitForSmpComplete(
  onProgress: (fraction: number) => void,
  onError: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (data.type === "smpProgress") {
        onProgress(data.fraction);
      } else if (data.type === "smpComplete") {
        worker.removeEventListener("message", handler);
        resolve();
      } else if (data.type === "smpError") {
        worker.removeEventListener("message", handler);
        onError(data.error);
        reject(new Error(data.error));
      }
    };
    worker.addEventListener("message", handler);
  });
}

// ── Drag-drop mbtiles anywhere ────────────────────────────────────────────
const dropOverlay = document.getElementById("drop-overlay")!;
let dragCounter = 0;

document.addEventListener("dragenter", (e) => {
  if (isMobile()) return;
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) dropOverlay.classList.remove("hidden");
});
document.addEventListener("dragover", (e) => {
  if (isMobile()) return;
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", (e) => {
  if (isMobile()) return;
  e.preventDefault();
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) dropOverlay.classList.add("hidden");
});
document.addEventListener("drop", (e) => {
  if (isMobile()) return;
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.add("hidden");
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  // GeoJSON files become overlays; an .mbtiles file replaces the basemap.
  const geojson = Array.from(files).filter(isGeoJSONFile);
  if (geojson.length > 0) {
    void overlayPanel.addFiles(geojson, "drop");
    return;
  }
  const mbtiles = Array.from(files).find((f) =>
    /\.(mbtiles|sqlite|sqlite3|db)$/i.test(f.name),
  );
  if (mbtiles) loadMbtilesFile(mbtiles, "drop");
});

// ── Resize re-evaluation (mobile vs desktop transitions) ──────────────────
window.addEventListener("resize", () => {
  bboxMap.setBottomInset(isMobile() ? MOBILE_BOTTOM_INSET : 0);
  overlayPanel.setMobile(isMobile());
});
