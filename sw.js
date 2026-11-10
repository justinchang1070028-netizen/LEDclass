/* LED 光舞教案 Service Worker：離線快取 + 影片 Range 支援 */
const VERSION = "v3";
const SHELL_CACHE = "led-shell-" + VERSION;
const VIDEO_CACHE = "led-video-v1"; // 影片快取不隨版本清除，避免重新下載大檔
const SHELL = [
  "./teacher.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("led-shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isVideo = (url) => /\.(mp4|webm|m4v)$/i.test(new URL(url).pathname);

/* 從完整回應切出 Range（<video> 拖曳進度與 iOS/Safari 播放都需要） */
async function rangeResponse(request, full) {
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") || "");
  if (!m) return full;
  const buf = await full.arrayBuffer();
  const size = buf.byteLength;
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (!m[1] && m[2]) { start = size - parseInt(m[2], 10); end = size - 1; }
  end = Math.min(end, size - 1);
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": full.headers.get("Content-Type") || "video/mp4",
      "Content-Range": "bytes " + start + "-" + end + "/" + size,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes"
    }
  });
}

async function handleVideo(request) {
  const cache = await caches.open(VIDEO_CACHE);
  const key = new Request(request.url);
  let full = await cache.match(key);
  if (!full) {
    // 未快取：抓完整檔（不帶 Range）存起來；失敗（離線/檔案不存在）則交給頁面顯示「影片尚未上傳」
    const res = await fetch(key);
    if (!res.ok) return res;
    await cache.put(key, res.clone());
    full = res;
  }
  return rangeResponse(request, full);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (isVideo(req.url)) {
    e.respondWith(handleVideo(req).catch(() => new Response("", { status: 404 })));
    return;
  }

  // 頁面導覽：優先用網路取得最新版，失敗則回快取（離線）
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((res) => {
        // 只快取成功的 teacher.html，避免 404 等錯誤頁蓋掉離線版本
        if (res.ok && new URL(req.url).pathname.endsWith("/teacher.html")) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("./teacher.html", copy));
        }
        return res;
      }).catch(() => caches.match("./teacher.html"))
    );
    return;
  }

  // 其他靜態檔：快取優先
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});

/* 頁面按下「離線儲存示範影片」時，把已上傳的影片全部抓進快取 */
self.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "CACHE_VIDEOS") return;
  const source = e.source;
  e.waitUntil((async () => {
    const cache = await caches.open(VIDEO_CACHE);
    let saved = 0;
    for (const u of e.data.urls) {
      const url = new URL(u, self.registration.scope).href;
      if (await cache.match(url)) { saved++; continue; }
      try {
        const res = await fetch(url);
        if (res.ok) { await cache.put(url, res); saved++; }
      } catch (_) { /* 略過尚未上傳的影片 */ }
    }
    if (source) source.postMessage({ type: "CACHE_VIDEOS_DONE", saved });
  })());
});
