// 浏览器里的本地存储（IndexedDB）。用来放：数据快照、缩略图缓存、预览图缓存、本地试用模式的文件。
// IndexedDB 不可用时（比如某些隐私模式）退回到内存，应用照常能用，只是关掉页面后缓存就没了。

const DB_NAME = 'birdlog';
const VERSION = 1;
const STORES = ['kv', 'thumbs', 'previews', 'localfiles'];

let dbPromise = null;
const mem = new Map();
const mk = (store, key) => store + '\u0000' + key;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const rq = indexedDB.open(DB_NAME, VERSION);
      rq.onupgradeneeded = () => {
        for (const s of STORES) if (!rq.result.objectStoreNames.contains(s)) rq.result.createObjectStore(s);
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(null);
      rq.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((db) => {
    if (!db) return undefined;
    return new Promise((resolve, reject) => {
      let result;
      const tx = db.transaction(store, mode);
      const rq = fn(tx.objectStore(store));
      if (rq) rq.onsuccess = () => { result = rq.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('本地存储写入被中止'));
    });
  });
}

export async function idbGet(store, key) {
  if (!(await open())) return mem.get(mk(store, key));
  return run(store, 'readonly', (os) => os.get(key));
}

export async function idbSet(store, key, value) {
  if (!(await open())) { mem.set(mk(store, key), value); return; }
  return run(store, 'readwrite', (os) => os.put(value, key));
}

export async function idbDel(store, key) {
  if (!(await open())) { mem.delete(mk(store, key)); return; }
  return run(store, 'readwrite', (os) => os.delete(key));
}

export async function idbClear(store) {
  if (!(await open())) {
    for (const k of [...mem.keys()]) if (k.startsWith(store + '\u0000')) mem.delete(k);
    return;
  }
  return run(store, 'readwrite', (os) => os.clear());
}

export async function idbKeys(store) {
  if (!(await open())) {
    return [...mem.keys()].filter((k) => k.startsWith(store + '\u0000')).map((k) => k.slice(store.length + 1));
  }
  return run(store, 'readonly', (os) => os.getAllKeys());
}
