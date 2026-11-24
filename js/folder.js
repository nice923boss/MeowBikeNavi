// Route folder mode: every saved route is one GPX file in a folder the rider picks on the phone.
// If that folder is synced by a cloud app, the routes sync with it. Needs the File System Access
// API (showDirectoryPicker): Chromium on Android and desktop. iPhone and Firefox do not have it.
import { routeToGpx, parseRouteFile, fileSafe } from './gpx.js';

export const folderSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const DB = 'mbn';
const STORE = 'kv';
const KEY = 'folder';

function idb(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

/** The folder handle remembered from last time, or null. */
export async function savedFolder() {
  try {
    return (await idb('readonly', (s) => s.get(KEY))) ?? null;
  } catch (err) {
    console.error('[folder] cannot read saved folder', err);
    return null;
  }
}
export const rememberFolder = (handle) => idb('readwrite', (s) => (handle ? s.put(handle, KEY) : s.delete(KEY)));

/** 'granted' | 'prompt' | 'denied'. ask = true must run inside a tap (browser rule). */
export async function folderAccess(handle, ask = false) {
  const options = { mode: 'readwrite' };
  if (!handle.queryPermission) return 'granted'; // private origin folders (tests) have no permission step
  const state = await handle.queryPermission(options);
  if (state === 'granted' || !ask) return state;
  return handle.requestPermission(options);
}

export async function pickFolder() {
  return window.showDirectoryPicker({ id: 'meowbikenavi-routes', mode: 'readwrite', startIn: 'documents' });
}

/** "name.gpx", or "name (2).gpx" … when taken. Comparison ignores case like phone file systems. */
export function uniqueFileName(name, taken) {
  const base = fileSafe(name).slice(0, 80);
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base}.gpx` : `${base} (${n}).gpx`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

const folderError = (err) => {
  console.error('[folder] file operation failed', err);
  if (err.name === 'NotFoundError') return new Error('找不到資料夾或檔案，可能已被移動或刪除，請重新整理或重新選擇資料夾');
  if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return new Error('沒有資料夾的存取權限，請按「允許存取」');
  if (err.name === 'QuotaExceededError') return new Error('手機儲存空間不足');
  return new Error(`資料夾讀寫失敗：${err.message}`);
};

/** Same methods as store.js, but async; ids are file names. */
export function folderStore(dir) {
  // Parsed files, reused while a file's size and date stay the same.
  const cache = new Map();

  async function read(name) {
    const file = await (await dir.getFileHandle(name)).getFile();
    const hit = cache.get(name);
    if (hit && hit.size === file.size && hit.date === file.lastModified) return hit.route;
    const [route] = parseRouteFile(await file.text(), name);
    const full = { ...route, id: name, updated_at: new Date(file.lastModified).toISOString() };
    cache.set(name, { size: file.size, date: file.lastModified, route: full });
    return full;
  }

  async function names() {
    const list = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && /\.gpx$/i.test(name)) list.push(name);
    }
    return list;
  }

  async function write(name, route) {
    const file = await dir.getFileHandle(name, { create: true });
    const out = await file.createWritable();
    await out.write(new Blob([routeToGpx(route)], { type: 'application/gpx+xml' }));
    await out.close();
    cache.delete(name);
  }

  const byNewest = (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || a.name.localeCompare(b.name);
  const wrap = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      // File system failures arrive as DOMException; our own errors already have a readable message.
      throw err instanceof DOMException ? folderError(err) : err;
    }
  };

  /** Every readable route, newest first, plus the files that could not be read. */
  const scan = wrap(async () => {
    const routes = [];
    const broken = [];
    for (const name of await names()) {
      try {
        routes.push(await read(name));
      } catch (err) {
        console.warn('[folder] skip unreadable file', name, err);
        broken.push(name);
      }
    }
    return { routes: routes.sort(byNewest), broken };
  });

  return {
    mode: 'folder',
    folderName: dir.name,
    scan,
    list: async () => (await scan()).routes.map(({ geometry, waypoints, turns, segments, ...summary }) => summary),
    getAll: async () => (await scan()).routes,
    get: wrap((id) => read(id)),
    create: wrap(async (route) => {
      const name = uniqueFileName(route.name, await names());
      await write(name, route);
      return name;
    }),
    /** Keeps the file name in step with the route name; returns the (maybe new) id. */
    update: wrap(async (id, patch) => {
      const route = { ...(await read(id)), ...patch };
      const wanted = fileSafe(route.name).slice(0, 80);
      let name = id;
      if (`${wanted}.gpx`.toLowerCase() !== id.toLowerCase()) {
        name = uniqueFileName(route.name, (await names()).filter((n) => n !== id));
      }
      await write(name, route);
      if (name !== id) {
        await dir.removeEntry(id);
        cache.delete(id);
      }
      return name;
    }),
    remove: wrap(async (id) => {
      await dir.removeEntry(id);
      cache.delete(id);
    }),
  };
}
