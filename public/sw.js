// Streams SMP downloads to disk in browsers without showSaveFilePicker, using
// the pattern from native-file-system-adapter. The main thread sends a
// MessagePort + URL; the SW rebuilds a ReadableStream from the port and
// answers a fetch for that URL with it, triggering a download via
// Content-Disposition.

const WRITE = 0;
const PULL = 0;
const ERROR = 1;
const CLOSE = 2;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

class MessagePortSource {
  constructor(port) {
    this.port = port;
    this.port.onmessage = (evt) => this.onMessage(evt.data);
  }

  start(controller) {
    this.controller = controller;
  }

  pull() {
    this.port.postMessage({ type: PULL });
  }

  cancel(reason) {
    this.port.postMessage({ type: ERROR, reason: String(reason) });
    this.port.close();
  }

  onMessage(message) {
    if (message.type === WRITE) {
      this.controller.enqueue(message.chunk);
    } else if (message.type === ERROR) {
      this.controller.error(message.reason);
      this.port.close();
    } else if (message.type === CLOSE) {
      this.controller.close();
      this.port.close();
    }
  }
}

const pending = new Map();

self.addEventListener("message", (evt) => {
  const data = evt.data;
  if (data?.url && data.readablePort) {
    const rs = new ReadableStream(
      new MessagePortSource(data.readablePort),
      new CountQueuingStrategy({ highWaterMark: 4 }),
    );
    pending.set(data.url, { rs, headers: data.headers });
  }
});

self.addEventListener("fetch", (event) => {
  const data = pending.get(event.request.url);
  if (!data) return;
  pending.delete(event.request.url);
  event.respondWith(new Response(data.rs, { headers: data.headers }));
});
