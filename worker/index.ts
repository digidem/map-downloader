const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const CAPTURE_PATH = "/ingest/i/v0/e/";

// `run_worker_first` routes /ingest/* here, but so does any non-navigation
// request that matches no static asset, hence the plain 404 fallback.
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Only the endpoint the app uses, so this isn't a relay to the whole
    // PostHog API.
    if (url.pathname !== CAPTURE_PATH) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.delete("authorization");
    // Cookieless mode hashes the client IP; without this every visitor would
    // share the worker's IP.
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) headers.set("X-Forwarded-For", ip);
    else headers.delete("X-Forwarded-For");
    const upstream = await fetch(POSTHOG_CAPTURE_URL + url.search, {
      method: "POST",
      headers,
      body: await request.arrayBuffer(),
    });
    const response = new Response(upstream.body, upstream);
    // Keeps the site cookie-free whatever PostHog sends back.
    response.headers.delete("set-cookie");
    return response;
  },
};
