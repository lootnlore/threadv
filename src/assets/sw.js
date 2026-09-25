// ThreadVet service worker: keeps the calculator working with no signal
// (thrift stores are notorious dead zones). The build replaces the two
// placeholders below with the asset version and the precache list.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `threadvet-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // cache: 'reload' skips the browser's HTTP cache, so unhashed files
      // (icons, manifest) are stored fresh under the new version.
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

const HASHED_ASSET = /^\/assets\/[a-z]+\.[0-9a-f]{10}\.(?:js|css)$/;
// Unhashed static files outside /assets/, served cache-first like the assets.
const STATIC_FILES = new Set(['/manifest.webmanifest', '/favicon.ico']);
const isPage = (pathname) => !pathname.startsWith('/assets/') && !STATIC_FILES.has(pathname);

// Pages the visitor opened before (e.g. a fee page used offline in a store)
// are copied into the new cache, with the hashed CSS/JS they use, so an
// update never takes them away. Copying needs no network, so activation
// (which page loads wait for) stays instant; each page refreshes itself the
// next time it loads online.
async function carryOver(oldNames) {
  const cache = await caches.open(CACHE);
  const have = new Set((await cache.keys()).map((r) => r.url));
  // caches.keys() lists caches oldest first: walk newest first so, if an
  // earlier cleanup failed and several old caches remain, the freshest copy wins.
  for (const name of [...oldNames].reverse()) {
    const old = await caches.open(name);
    for (const request of await old.keys()) {
      const { pathname } = new URL(request.url);
      if (have.has(request.url) || !(isPage(pathname) || HASHED_ASSET.test(pathname))) continue;
      const response = await old.match(request);
      if (response) await cache.put(request, response);
      have.add(request.url);
    }
  }
  await pruneAssets(cache);
}

// Drop hashed CSS/JS that no cached page (or a module it imports) uses anymore.
async function pruneAssets(cache) {
  const requests = await cache.keys();
  const byPath = new Map(requests.map((r) => [new URL(r.url).pathname, r]));
  const used = new Set();
  const scanned = new Set();
  const queue = [...byPath.keys()].filter(isPage);
  for (const url of PRECACHE) {
    const path = new URL(url, self.location.href).pathname;
    used.add(path);
    if (path.endsWith('.js')) queue.push(path);
  }
  while (queue.length) {
    const path = queue.pop();
    if (scanned.has(path) || !byPath.has(path)) continue;
    scanned.add(path);
    const text = await (await cache.match(byPath.get(path))).text();
    for (const [ref, file] of text.matchAll(/\/assets\/[a-z]+\.[0-9a-f]{10}\.(?:js|css)|\.\/([a-z]+\.[0-9a-f]{10}\.js)/g)) {
      const asset = file ? `/assets/${file}` : ref;
      used.add(asset);
      if (asset.endsWith('.js')) queue.push(asset);
    }
  }
  await Promise.all(
    [...byPath].filter(([path]) => HASHED_ASSET.test(path) && !used.has(path)).map(([, request]) => cache.delete(request)),
  );
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const old = (await caches.keys()).filter((k) => k.startsWith('threadvet-') && k !== CACHE);
      await carryOver(old);
      await Promise.all(old.map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

const NETWORK_TIMEOUT_MS = 3000;

// Pages: fresh from the network when it answers quickly, otherwise the cached
// copy (one bar of signal in a thrift store shouldn't mean a blank screen).
async function networkFirst(event) {
  const cache = await caches.open(CACHE);
  const key = new URL(event.request.url);
  key.search = '';
  const cached = async () => {
    const hit = await cache.match(key.href);
    if (hit || key.pathname.endsWith('/') || /\.[a-z0-9]+$/i.test(key.pathname)) return hit;
    // /fees/ebay is /fees/ebay/ without its slash. Redirect like the server
    // does (rather than serve the page at the wrong URL, which would break its
    // relative links); the redirected load then finds the cached page.
    const slashed = new URL(key);
    slashed.pathname += '/';
    if (!(await cache.match(slashed.href))) return undefined;
    const target = new URL(event.request.url);
    target.pathname += '/';
    return Response.redirect(target.href, 301);
  };
  const network = fetch(event.request);
  // Store fresh pages; waitUntil keeps the worker alive until the write lands.
  event.waitUntil(
    network.then((response) => (response.ok ? cache.put(key.href, response.clone()) : undefined)).catch(() => {}),
  );
  try {
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, 'timeout'));
    const winner = await Promise.race([network, timeout]);
    if (winner === 'timeout') return (await cached()) ?? (await network);
    // A server error (e.g. during a restart) shouldn't replace a good cached page.
    if (winner.status >= 500) return (await cached()) ?? winner;
    return winner;
  } catch {
    return (await cached()) ?? (await cache.match('/offline.html')) ?? Response.error();
  }
}

async function cacheFirst(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  // waitUntil keeps the worker alive until the write lands.
  if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(event));
  } else if (url.pathname.startsWith('/assets/') || STATIC_FILES.has(url.pathname)) {
    event.respondWith(cacheFirst(event));
  }
});
