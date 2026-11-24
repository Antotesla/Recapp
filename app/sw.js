// Service worker: funzionamento offline + ricezione dei vocali da "Condividi" (Android).

const CACHE = 'recapp-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'ai.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Prima la rete (così gli aggiornamenti arrivano subito), poi la copia locale.
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    } catch {
      return (await caches.match(e.request, { ignoreSearch: true }))
        || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error());
    }
  })());
});

function openInbox() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('recapp-inbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function receiveShare(request) {
  let count = 0;
  try {
    const form = await request.formData();
    const files = form.getAll('audio').filter(f => f && typeof f !== 'string');
    const d = await openInbox();
    await new Promise((res, rej) => {
      const t = d.transaction('files', 'readwrite');
      const s = t.objectStore('files');
      for (const f of files) {
        s.add({ blob: new Blob([f], { type: f.type }), name: f.name, type: f.type, lastModified: f.lastModified });
      }
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
    d.close();
    count = files.length;
  } catch (err) {
    console.error('Condivisione non riuscita', err);
  }
  return Response.redirect(new URL(`./?shared=${count}`, self.registration.scope).href, 303);
}
