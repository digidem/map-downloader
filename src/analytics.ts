import type { GeoBbox } from "./bbox-map.ts";
import { isTileUrlTemplate, type AppStyle } from "./preset-styles.ts";

type Props = Record<string, string | number | boolean>;

const POSTHOG_TOKEN = "phc_m6grg3eEFLGiBVboGAvhsfQpFjHPfLqkvKN3ixm8LL8i";
const POSTHOG_ENDPOINT = "https://us.i.posthog.com/i/v0/e/";
// Keeps dev, e2e, PR-preview and automated traffic out of PostHog.
const POSTHOG_ENABLED =
  location.hostname === "map-downloader.comapeo.app" && !navigator.webdriver;

function detectBrowser(ua: string): string {
  if (/Edg\//.test(ua)) return "Microsoft Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/Firefox|FxiOS/.test(ua)) return "Firefox";
  if (/Chrome|CriOS/.test(ua)) return "Chrome";
  if (/Safari/.test(ua)) return "Safari";
  return "Other";
}

function detectOs(ua: string): string {
  if (/Windows/.test(ua)) return "Windows";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "Chrome OS";
  if (/Mac/.test(ua)) return "Mac OS X";
  if (/Linux/.test(ua)) return "Linux";
  return "Other";
}

function detectDeviceType(ua: string): string {
  if (/iPad|Tablet/.test(ua)) return "Tablet";
  if (/Mobi|iPhone|Android/.test(ua)) return "Mobile";
  return "Desktop";
}

/** Cookieless capture: PostHog derives a daily visitor hash server-side from
 *  IP, `$raw_user_agent` and `$host`, and drops events missing either field.
 *  Requires "Cookieless server hash mode" in the project settings. */
function sendToPostHog(event: string, properties: Record<string, unknown>) {
  if (!POSTHOG_ENABLED) return;
  const ua = navigator.userAgent;
  const referrer = document.referrer;
  fetch(POSTHOG_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({
      api_key: POSTHOG_TOKEN,
      event,
      distinct_id: "$posthog_cookieless",
      timestamp: new Date().toISOString(),
      properties: {
        ...properties,
        $cookieless_mode: true,
        $process_person_profile: false,
        $raw_user_agent: ua,
        $host: location.host,
        $current_url: location.href,
        $pathname: location.pathname,
        $referrer: referrer || "$direct",
        $referring_domain: referrer ? new URL(referrer).host : "$direct",
        $browser: detectBrowser(ua),
        $os: detectOs(ua),
        $device_type: detectDeviceType(ua),
        $browser_language: navigator.language,
        $timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        $screen_width: screen.width,
        $screen_height: screen.height,
        $viewport_width: innerWidth,
        $viewport_height: innerHeight,
        $lib: "map-downloader",
      },
    }),
  }).catch(() => {});
}

export function initAnalytics() {
  try {
    sendToPostHog("$pageview", {});
  } catch {
    // Analytics must never break the app.
  }
}

/** Send an event to PostHog. Exact numbers are for aggregation; the bucketed
 *  values alongside them keep breakdowns readable. */
export function track(event: string, props: Props = {}) {
  try {
    sendToPostHog(event, props);
  } catch {
    // Analytics must never break the app.
  }
}

// Bucketed alongside the exact numbers so a breakdown by value stays readable.
const AREA_KM2_EDGES = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000];
const TILE_EDGES = [100, 1_000, 10_000, 25_000, 100_000, 500_000, 1_000_000];
const SIZE_MB_EDGES = [1, 10, 50, 100, 250, 1_000, 2_500];
const FEATURE_EDGES = [10, 100, 1_000, 10_000, 100_000];
const DURATION_S_EDGES = [10, 60, 300, 1_800];

function compact(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}k`;
  return String(n);
}

function bucket(value: number, edges: number[]): string {
  for (let i = 0; i < edges.length; i++) {
    if (value < edges[i]) {
      return i === 0
        ? `<${compact(edges[0])}`
        : `${compact(edges[i - 1])}–${compact(edges[i])}`;
    }
  }
  return `≥${compact(edges[edges.length - 1])}`;
}

export const areaBucket = (km2: number) => bucket(km2, AREA_KM2_EDGES);
export const tileBucket = (tiles: number) => bucket(tiles, TILE_EDGES);
export const sizeBucket = (bytes: number) =>
  bucket(bytes / (1024 * 1024), SIZE_MB_EDGES);
export const featureBucket = (n: number) => bucket(n, FEATURE_EDGES);
export const durationBucket = (ms: number) =>
  bucket(ms / 1000, DURATION_S_EDGES);

export function bboxAreaKm2(b: GeoBbox): number {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  return (
    R *
    R *
    Math.abs((b.east - b.west) * rad) *
    Math.abs(Math.sin(b.north * rad) - Math.sin(b.south * rad))
  );
}

/** 10° grid cell of the bbox centre, e.g. "50N 0E" — coarse enough that it
 *  can't pinpoint a user's home or site. */
export function regionCell(b: GeoBbox): string {
  const lat = Math.floor((b.south + b.north) / 2 / 10) * 10;
  const lng = Math.floor((b.west + b.east) / 2 / 10) * 10;
  return `${Math.abs(lat)}${lat < 0 ? "S" : "N"} ${Math.abs(lng)}${lng < 0 ? "W" : "E"}`;
}

/** Host only — full custom URLs can carry API keys in the path or query. */
export function urlHost(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url);
  return m ? m[1].toLowerCase() : "unknown";
}

/** Strip URLs (which may embed tokens) and cap length. */
export function sanitizeError(msg: string): string {
  return msg.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 200);
}

export function customUrlType(url: string, hasSpec: boolean): string {
  if (isTileUrlTemplate(url)) return "tile-url";
  return hasSpec ? "tilejson" : "style-json";
}

export function styleProps(style: AppStyle): Props {
  const common = { kind: style.kind, license: style.license };
  if ("isMbtiles" in style && style.isMbtiles) {
    // The file name may be personal, so it isn't sent.
    return { ...common, source: "mbtiles", style: "Local .mbtiles" };
  }
  if (style.id === "custom") {
    return {
      ...common,
      source: "custom",
      style: urlHost(style.url),
      custom_type: customUrlType(style.url, "spec" in style && !!style.spec),
    };
  }
  return {
    ...common,
    source: style.id.startsWith("qms-") ? "qms" : "preset",
    style: style.name,
  };
}
