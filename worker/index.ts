const POSTHOG_HOST = "us.i.posthog.com";
const PREFIX = "/ingest/";

// Only /ingest/* reaches this script (`run_worker_first` in wrangler.jsonc);
// everything else is served straight from the static assets.
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) {
      return new Response("Not found", { status: 404 });
    }
    const target = `https://${POSTHOG_HOST}/${url.pathname.slice(PREFIX.length)}${url.search}`;
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.delete("authorization");
    // Cookieless mode hashes the client IP; without this every visitor would
    // share the worker's IP.
    headers.set(
      "X-Forwarded-For",
      request.headers.get("CF-Connecting-IP") ?? "",
    );
    return fetch(target, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? null
          : await request.arrayBuffer(),
    });
  },
};
