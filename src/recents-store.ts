import { combineAttributions } from "./attribution.ts";
import { mapboxStyleUri, parseMapboxStyleUrl } from "./mapbox.ts";
import {
  customSourceInfo,
  sourceHost,
  type CustomStyle,
} from "./preset-styles.ts";

export interface RecentEntry {
  /** Stable id for the recent — derived from the URL so the same URL doesn't
   *  appear twice. */
  id: string;
  /** The source's own name (style.json / TileJSON `name`). Equal to `url`
   *  when the source had none. */
  name: string;
  /** The URL exactly as the user entered it (sans token). */
  url: string;
  /** kind/spec/access-token are stashed verbatim from the validated style so
   *  we can reuse without re-validating. */
  kind: CustomStyle["kind"];
  spec?: CustomStyle["spec"];
  accessToken?: string;
  /** The source's own attribution HTML, sanitised. */
  attribution?: string;
  /** TileJSON's maxzoom (when the validated source supplied one) — used so
   *  the download modal's slider cap is set instantly without a second fetch. */
  maxZoom?: number;
  /** A raster {z}/{x}/{y} URL to use as the preview thumbnail when possible.
   *  For style URLs we follow source.tiles[0]; if that's vector pbf we leave
   *  this unset and the card falls back to a solid swatch. */
  previewTileUrl?: string;
  /** Subdomain list for tile templates containing `{subdomain}`/`{s}` — needed
   *  to fill `previewTileUrl` correctly for hosts like Bing (t0–t3). */
  subdomains?: string[];
  /** Set to "raster" only when previewTileUrl points at an image-format tile;
   *  vector pbf can't be rendered into an <img>. */
  previewKind?: "raster";
  addedAt: number;
}

const KEY = "map-downloader:recents:v1";
const MAX = 10;

export function loadRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .filter(
        (e): e is RecentEntry =>
          e && typeof e.id === "string" && typeof e.url === "string",
      )
      .map(migrateMapboxEntry)
      .filter((e) => !seen.has(e.id) && !!seen.add(e.id));
  } catch {
    return [];
  }
}

/** Entries saved before Mapbox links were parsed hold an api.mapbox.com URL,
 *  sometimes with the token in it; the app now needs mapbox:// + a token. */
function migrateMapboxEntry(e: RecentEntry): RecentEntry {
  const ref = parseMapboxStyleUrl(e.url);
  if (!ref) return e;
  const url = mapboxStyleUri(ref);
  if (url === e.url) return e;
  return {
    ...e,
    id: recentIdForUrl(url),
    url,
    name: e.name === e.url ? url : e.name,
    accessToken: e.accessToken ?? ref.accessToken,
  };
}

export function saveRecent(entry: RecentEntry) {
  const existing = loadRecents().filter((e) => e.id !== entry.id);
  const next = [entry, ...existing].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full / disabled — silently drop */
  }
}

export function removeRecent(id: string) {
  const next = loadRecents().filter((e) => e.id !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function recentDisplayName(r: RecentEntry): string {
  if (r.name !== r.url) return r.name;
  return parseMapboxStyleUrl(r.url) ? "Mapbox style" : sourceHost(r.url);
}

export function customStyleFromRecent(r: RecentEntry): CustomStyle {
  return {
    id: "custom",
    name: recentDisplayName(r),
    desc: r.url,
    url: r.url,
    kind: r.kind,
    spec: r.spec,
    accessToken: r.accessToken,
    maxZoom: r.maxZoom,
    // Custom sources carry no licence metadata — flag them restrictive.
    license: "restrictive",
    // Re-sanitised because it's rendered as HTML.
    ...customSourceInfo(
      r.url,
      r.attribution && combineAttributions([r.attribution]),
    ),
  };
}

export function recentIdForUrl(url: string): string {
  // Hash-ish but readable; collisions don't matter beyond shadowing the older
  // entry with the same URL (which is what we want).
  return url.toLowerCase();
}

// ─── Selected-style persistence ────────────────────────────────────────────
// We store either a preset id ("positron", "satellite", ...) OR a recent id
// (a lowercased URL). mbtiles-loaded styles are deliberately not persisted —
// the underlying file is OPFS-scoped and gone after a refresh.
const SELECTED_KEY = "map-downloader:selected:v1";

export interface SelectedRef {
  kind: "preset" | "recent";
  id: string;
}

export function loadSelected(): SelectedRef | null {
  try {
    const raw = localStorage.getItem(SELECTED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      (parsed.kind === "preset" || parsed.kind === "recent") &&
      typeof parsed.id === "string"
    ) {
      return parsed as SelectedRef;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function saveSelected(ref: SelectedRef | null) {
  try {
    if (ref) localStorage.setItem(SELECTED_KEY, JSON.stringify(ref));
    else localStorage.removeItem(SELECTED_KEY);
  } catch {
    /* ignore */
  }
}
