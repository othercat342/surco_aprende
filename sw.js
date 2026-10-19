// Service worker simple de Surco Aprende.
// Estrategia: red primero (así siempre ves la última versión) y, si no hay internet, usa lo guardado.
// El chat (/api/*) nunca se guarda: siempre necesita internet.
const CACHE = "surco-v3";
const SHELL = [
  "/", "/index.html", "/styles.css",
  "/data.js", "/notes.js", "/piano.js", "/artists.js",
  "/practica.js", "/historia.js", "/chat.js", "/menu.js", "/auth.js", "/racha.js",
  "/logo-header.png", "/icon-192.png", "/icono-512.png", "/manifest.json"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("/index.html") : undefined))
      )
  );
});
