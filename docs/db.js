// Archivio locale (IndexedDB): tutto resta sul telefono.

const DB_NAME = 'recapp';
const DB_VERSION = 1;

// Inbox condivisa con il service worker: i file arrivati da "Condividi"
// vengono parcheggiati qui finché la pagina non li prende in carico.
// Nome e schema devono restare identici a quelli in sw.js.
const INBOX_DB = 'recapp-inbox';

const req = r => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

let dbPromise;
function open() {
  if (!dbPromise) {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      const notes = d.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('day', 'day');
      notes.createIndex('hash', 'hash');
      d.createObjectStore('digests', { keyPath: 'day' });
    };
    dbPromise = req(r);
  }
  return dbPromise;
}

async function store(name, mode = 'readonly') {
  const d = await open();
  return d.transaction(name, mode).objectStore(name);
}

export const put = async (name, value) => req((await store(name, 'readwrite')).put(value));
export const get = async (name, key) => req((await store(name)).get(key));
export const del = async (name, key) => req((await store(name, 'readwrite')).delete(key));
export const all = async name => req((await store(name)).getAll());
export const byIndex = async (name, index, key) => req((await store(name)).index(index).getAll(key));

function openInbox() {
  const r = indexedDB.open(INBOX_DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore('files', { autoIncrement: true });
  return req(r);
}

// Restituisce e svuota i file in attesa nell'inbox.
export async function takeInbox() {
  const d = await openInbox();
  return new Promise((res, rej) => {
    const t = d.transaction('files', 'readwrite');
    const s = t.objectStore('files');
    let items = [];
    s.getAll().onsuccess = e => {
      items = e.target.result;
      s.clear();
    };
    t.oncomplete = () => { d.close(); res(items); };
    t.onerror = () => rej(t.error);
  });
}
