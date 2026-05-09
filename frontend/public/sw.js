/**
 * FPV Drone Catalog — Service Worker
 *
 * Strategy:
 *   - App shell (JS/CSS/HTML): CacheFirst — fast loads
 *   - GET /api/* : NetworkFirst → fallback to cache — offline read
 *   - POST/PATCH /api/batteries/:id (cycle++) : Background Sync queue
 *   - POST /api/drones/:id/flights : Background Sync queue
 */

const CACHE_NAME = 'fpv-v1';
const SYNC_QUEUE_KEY = 'fpv-sync-queue';

// App shell routes to precache
const PRECACHE_URLS = ['/', '/drones', '/batteries', '/snapshots', '/catalogue', '/offline'];

// ── Install ────────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(PRECACHE_URLS).catch(() => {})
    )
  );
  self.skipWaiting();
});

// ── Activate ───────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ──────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Static assets: CacheFirst
  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'image' ||
    request.destination === 'font' ||
    url.pathname.startsWith('/_next/static/')
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // GET API calls: NetworkFirst with cache fallback
  if (request.method === 'GET' && url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstAPI(request));
    return;
  }

  // Write API calls (PATCH battery cycle, POST flight note): queue when offline
  if (
    (request.method === 'PATCH' || request.method === 'POST') &&
    url.pathname.startsWith('/api/')
  ) {
    event.respondWith(queueableWrite(request));
    return;
  }

  // HTML navigation: NetworkFirst, fallback to cached page or /offline
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNav(request));
    return;
  }
});

// ── Background Sync ────────────────────────────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'fpv-write-queue') {
    event.waitUntil(flushQueue());
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirstAPI(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      // Add header so UI can show "offline data" indicator
      const headers = new Headers(cached.headers);
      headers.set('X-From-Cache', '1');
      const body = await cached.arrayBuffer();
      return new Response(body, { status: 200, headers });
    }
    return new Response(JSON.stringify({ error: 'offline', cached: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function networkFirstNav(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request) || await caches.match('/');
    return cached || caches.match('/offline');
  }
}

async function queueableWrite(request) {
  try {
    return await fetch(request);
  } catch {
    // Network down — serialize request and store in queue
    const body = await request.text().catch(() => '');
    const entry = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      queuedAt: Date.now(),
    };
    await addToQueue(entry);
    // Register background sync
    self.registration.sync?.register('fpv-write-queue').catch(() => {});
    // Optimistic 200 response so UI can update immediately
    return new Response(JSON.stringify({ queued: true, offline: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Queued': '1' },
    });
  }
}

// Queue stored in Cache API as a JSON blob
async function getQueue() {
  const cache = await caches.open('fpv-queue');
  const resp = await cache.match('/_queue');
  if (!resp) return [];
  return resp.json().catch(() => []);
}

async function addToQueue(entry) {
  const queue = await getQueue();
  queue.push(entry);
  const cache = await caches.open('fpv-queue');
  cache.put('/_queue', new Response(JSON.stringify(queue)));
}

async function flushQueue() {
  const queue = await getQueue();
  const remaining = [];
  for (const entry of queue) {
    try {
      await fetch(entry.url, {
        method: entry.method,
        headers: entry.headers,
        body: entry.body || undefined,
      });
    } catch {
      remaining.push(entry);
    }
  }
  const cache = await caches.open('fpv-queue');
  cache.put('/_queue', new Response(JSON.stringify(remaining)));
  // Notify all clients that sync completed
  const clients = await self.clients.matchAll();
  clients.forEach((c) => c.postMessage({ type: 'SYNC_COMPLETE', remaining: remaining.length }));
}
