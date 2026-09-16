const API_URL = "https://api.mapbox.com";

export interface MapboxStyleRef {
  owner: string;
  styleId: string;
  /** Token found in the pasted URL's `access_token` query param, if any. */
  accessToken?: string;
}

const SEGMENT = "([A-Za-z0-9_-]+)";
/** Path shapes that identify a style, after the scheme/host:
 *  - mapbox://styles/{owner}/{id}
 *  - api.mapbox.com/styles/v1/{owner}/{id}[.html | /wmts | /tiles/… | /]
 *  - studio.mapbox.com/styles/{owner}/{id}[/edit/…] */
const STYLE_PATTERNS: [host: string, path: RegExp][] = [
  ["styles", new RegExp(`^/${SEGMENT}/${SEGMENT}(?:/|$)`)],
  [
    "api.mapbox.com",
    new RegExp(`^/styles/v1/${SEGMENT}/${SEGMENT}(?:\\.html|/|$)`),
  ],
  ["studio.mapbox.com", new RegExp(`^/styles/${SEGMENT}/${SEGMENT}(?:/|$)`)],
];

/** Extract owner + style id from any of the URL forms Mapbox shows a user for
 *  a style (share → web, share → third party/WMTS, the preview page, Studio). */
export function parseMapboxStyleUrl(input: string): MapboxStyleRef | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const isMapboxScheme = url.protocol === "mapbox:";
  if (!isMapboxScheme && url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  const host = url.hostname.toLowerCase();
  for (const [expectedHost, re] of STYLE_PATTERNS) {
    if (host !== expectedHost) continue;
    if ((expectedHost === "styles") !== isMapboxScheme) continue;
    const m = re.exec(url.pathname);
    if (!m) continue;
    const accessToken = url.searchParams.get("access_token") || undefined;
    return { owner: m[1], styleId: m[2], accessToken };
  }
  return null;
}

export function mapboxStyleUri({ owner, styleId }: MapboxStyleRef): string {
  return `mapbox://styles/${owner}/${styleId}`;
}

export function isMapboxUrl(url: string): boolean {
  return url.startsWith("mapbox://");
}

/** Resolve a `mapbox://` style, source, sprite or glyph URL to its HTTPS API
 *  endpoint, mirroring mapbox-gl-js. Other URLs pass through unchanged. */
export function normalizeMapboxUrl(url: string, accessToken?: string): string {
  if (!isMapboxUrl(url)) return url;
  if (!accessToken) throw new Error("Mapbox URLs require an access token");
  const parsed = new URL(url);
  const kind = parsed.hostname;
  const path = parsed.pathname;
  let out: URL;
  if (kind === "styles") {
    out = new URL(`${API_URL}/styles/v1${path}`);
  } else if (kind === "fonts") {
    out = new URL(`${API_URL}/fonts/v1${path}`);
  } else if (kind === "sprites") {
    // MapLibre appends `@2x.json` etc. to the sprite path; Mapbox serves it
    // as `…/sprite@2x.json` under the style.
    const m = /^(.*?)((?:@\dx)?\.(?:json|png))?$/.exec(path)!;
    out = new URL(`${API_URL}/styles/v1${m[1]}/sprite${m[2] ?? ""}`);
  } else {
    // Tileset source, e.g. mapbox://mapbox.mapbox-streets-v8 → TileJSON.
    out = new URL(`${API_URL}/v4/${kind}.json`);
    out.searchParams.set("secure", "");
  }
  parsed.searchParams.forEach((v, k) => out.searchParams.set(k, v));
  out.searchParams.set("access_token", accessToken);
  return out.toString();
}

export const MAPBOX_TERMS_URL = "https://www.mapbox.com/legal/tos";
export const MAPBOX_ATTRIBUTION =
  '<a href="https://www.mapbox.com/about/maps/">© Mapbox</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>';
