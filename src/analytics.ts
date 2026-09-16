import type { GeoBbox } from "./bbox-map.ts";
import { isTileUrlTemplate, type AppStyle } from "./preset-styles.ts";

type Props = Record<string, string | number | boolean>;

/** Event names are static; anything variable belongs in a property. */
export type AnalyticsEvent =
  | "style_picker_open"
  | "style_select"
  | "custom_url_validate"
  | "bounds_edit"
  | "bounds_lock"
  | "info_panel_open"
  | "overlay_add"
  | "download_dialog_open"
  | "huge_download_prompt"
  | "download_start"
  | "download_complete"
  | "download_fail";

const POSTHOG_TOKEN = "phc_m6grg3eEFLGiBVboGAvhsfQpFjHPfLqkvKN3ixm8LL8i";
// Proxied by the worker (worker/index.ts) so ad blockers don't drop events.
const POSTHOG_ENDPOINT = "/ingest/i/v0/e/";
const CAMPAIGN_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
];
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
      // No client timestamp: a skewed device clock can put the event on a day
      // the cookieless hash rejects. Events are sent immediately anyway.
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

function campaignProps(): Props {
  const params = new URLSearchParams(location.search);
  const props: Props = {};
  for (const key of CAMPAIGN_PARAMS) {
    const value = params.get(key);
    if (value) props[key] = value;
  }
  return props;
}

let pageviewAt = 0;
let pageleaveSent = false;

function sendPageview() {
  pageviewAt = Date.now();
  pageleaveSent = false;
  sendToPostHog("$pageview", campaignProps());
}

// Without a $pageleave, a visit with no other events has zero duration and
// counts as a bounce. Mobile browsers often skip `pagehide` when a
// backgrounded tab is killed, so a hidden page counts as leaving too.
function sendPageleave() {
  if (pageleaveSent) return;
  pageleaveSent = true;
  sendToPostHog("$pageleave", {
    $prev_pageview_pathname: location.pathname,
    $prev_pageview_duration: (Date.now() - pageviewAt) / 1000,
  });
}

function safely(fn: () => void) {
  return () => {
    try {
      fn();
    } catch {
      // Analytics must never break the app.
    }
  };
}

export function initAnalytics() {
  safely(sendPageview)();
  window.addEventListener("pagehide", safely(sendPageleave));
  document.addEventListener(
    "visibilitychange",
    safely(() => {
      if (document.visibilityState === "hidden") sendPageleave();
    }),
  );
  // A page restored from the back/forward cache is a new visit.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) safely(sendPageview)();
  });
}

export function track(event: AnalyticsEvent, props: Props = {}) {
  try {
    sendToPostHog(event, props);
  } catch {
    // Analytics must never break the app.
  }
}

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
  const common = { style_kind: style.kind, style_license: style.license };
  if ("isMbtiles" in style && style.isMbtiles) {
    // The file name may be personal, so it isn't sent.
    return {
      ...common,
      style_source: "mbtiles",
      style_name: "Local .mbtiles",
    };
  }
  if (style.id === "custom") {
    return {
      ...common,
      style_source: "custom",
      style_name: urlHost(style.url),
      custom_url_type: customUrlType(
        style.url,
        "spec" in style && !!style.spec,
      ),
    };
  }
  return {
    ...common,
    style_source: style.id.startsWith("qms-") ? "qms" : "preset",
    style_name: style.name,
  };
}
