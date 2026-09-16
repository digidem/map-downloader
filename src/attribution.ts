const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function safeHref(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

interface AttributionItem {
  label: string;
  html: string;
}

/** Split third-party attribution HTML into its credits, keeping only text and
 *  http(s) links — the result is rendered as HTML in the attribution popover. */
function attributionItems(source: string): AttributionItem[] {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const items: AttributionItem[] = [];
  let text = "";
  const flushText = () => {
    const label = collapse(text);
    if (label) items.push({ label, html: escapeHtml(label) });
    text = "";
  };
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent ?? "";
      } else if (child instanceof HTMLAnchorElement) {
        flushText();
        const label = collapse(child.textContent ?? "");
        if (!label) continue;
        const href = safeHref(child.getAttribute("href"));
        items.push({
          label,
          html: href
            ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
            : escapeHtml(label),
        });
      } else if (child instanceof Element && !SKIPPED_TAGS.has(child.tagName)) {
        walk(child);
      }
    }
  };
  walk(doc.body);
  flushText();
  return items;
}

/** Merge the attributions of several sources into one safe HTML string,
 *  dropping credits repeated across sources. Undefined when there are none. */
export function combineAttributions(sources: string[]): string | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    for (const item of attributionItems(source)) {
      const key = item.label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item.html);
    }
  }
  return out.length ? out.join(" ") : undefined;
}
