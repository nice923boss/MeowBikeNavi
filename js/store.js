// Saved routes live in this browser's localStorage. Export files are the backup and the way to share.
// Route: { id, name, vehicle, preset, waypoints: [{lat, lon, label?}], geometry (polyline6),
//          turns: [{i, k, from?, to?}] (see turns.js), segments?: [{to, locked, walk, distance_m, duration_s}]
//          (see segments.js), distance_m, duration_s, updated_at }
const KEY = 'mbn.routes';

function readAll() {
  let raw;
  try {
    raw = localStorage.getItem(KEY);
  } catch (err) {
    console.error('[store] localStorage unavailable', err);
    throw new Error('瀏覽器不允許儲存資料（可能是無痕模式），無法使用我的路線');
  }
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new TypeError('not an array');
    return list;
  } catch (err) {
    console.error('[store] corrupted route data', err);
    throw new Error('已儲存的路線資料損毀，無法讀取');
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (err) {
    console.error('[store] write failed', err);
    throw new Error('手機儲存空間不足，請先匯出並刪除舊路線');
  }
  // Ask the browser not to evict this site's data under storage pressure (best effort).
  navigator.storage?.persist?.().catch((err) => console.warn('[store] persist request failed', err));
}

const byNewest = (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id;

export function list() {
  return readAll().slice().sort(byNewest).map(({ geometry, waypoints, turns, segments, ...summary }) => summary);
}

export function get(id) {
  const route = readAll().find((r) => r.id === id);
  if (!route) throw new Error('找不到這條路線');
  return route;
}

export function getAll() {
  return readAll().slice().sort(byNewest);
}

export function create(route) {
  const all = readAll();
  const id = all.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  writeAll([...all, { ...route, id, updated_at: new Date().toISOString() }]);
  return id;
}

export function update(id, patch) {
  const all = readAll();
  if (!all.some((r) => r.id === id)) throw new Error('找不到這條路線');
  writeAll(all.map((r) => (r.id === id ? { ...r, ...patch, id, updated_at: new Date().toISOString() } : r)));
}

export function remove(id) {
  writeAll(readAll().filter((r) => r.id !== id));
}
