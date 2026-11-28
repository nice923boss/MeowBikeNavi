// Planner: map, start/via/end points, saved routes, search. Navigation itself lives in nav.js.
import { DEFAULT_VIEW, VEHICLES, BIKE_PRESETS, TILE_LAYERS } from './config.js';
import { decodePolyline, encodePolyline, cumulative, haversine, formatDistance, formatDuration } from './geo.js';
import { planSegments, ServiceError } from './services.js';
import { setupSearch } from './search-ui.js';
import { blankSegment, carrySegments, joinSegments, segmentMeta, cleanSegmentMeta, splitLine, viaSlot } from './segments.js';
import { segmentRow, segmentStyle } from './segment-ui.js';
import * as store from './store.js';
import { routeToGpx, backupJson, parseRouteFile, fileSafe } from './gpx.js';
import { folderSupported, savedFolder, rememberFolder, folderAccess, pickFolder, folderStore } from './folder.js';
import { h, toast, dialog, shareOrDownload, pickFiles, lsGet, lsSet, geoErrorText } from './ui.js';
import { pinIcon } from './icons.js';
import { createNavigator } from './nav.js';
import { centerFor } from './view.js';
import { setupSheetDrag } from './sheet-drag.js';
import { setupVoice } from './voice-ui.js';

const L = window.L;
const $ = (id) => document.getElementById(id);
const MAX_VIAS = 48;
const SIM = new URLSearchParams(location.search).has('sim');

const cat = (name) => h('img', { src: `img/cat-${name}.webp`, alt: '' });
const coordText = (p) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
const labelOf = (p) => p.label || coordText(p);
const makePoint = (lat, lon, label) => ({
  lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), ...(label ? { label: String(label).slice(0, 120) } : {}),
});

window.addEventListener('error', (event) => {
  console.error('[app] uncaught error', event.error ?? event.message);
  toast('發生未預期的錯誤，請重新整理頁面再試', 'error');
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[app] unhandled rejection', event.reason);
  toast('發生未預期的錯誤，請重新整理頁面再試', 'error');
});

if (L) {
  main();
} else {
  console.error('[app] Leaflet failed to load');
  $('map').replaceChildren(h('div', { class: 'map-error' }, cat('surprise'), '地圖元件載入失敗，請確認網路後重新整理'));
}

function main() {
  // ---------- map ----------
  const savedView = lsGet('mbn.view', null);
  const view = Array.isArray(savedView?.center) && savedView.center.every(Number.isFinite) && Number.isFinite(savedView.zoom)
    ? savedView : DEFAULT_VIEW;
  const map = L.map('map', { center: view.center, zoom: view.zoom, zoomControl: false });
  map.attributionControl.setPrefix('製作者：黃政文');
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  const wide = window.matchMedia('(min-width: 720px)');
  if (wide.matches) L.control.zoom({ position: 'topright' }).addTo(map);

  let tiles = null;
  let layerKey = null;
  function setLayer(key) {
    if (tiles) map.removeLayer(tiles);
    tiles = L.tileLayer(TILE_LAYERS[key].url, TILE_LAYERS[key].options).addTo(map);
    layerKey = key;
    lsSet('mbn.layer', key);
    $('btn-layer').classList.toggle('on', key === 'cycle');
  }
  const savedLayer = lsGet('mbn.layer', 'standard');
  setLayer(savedLayer in TILE_LAYERS ? savedLayer : 'standard');
  $('btn-layer').addEventListener('click', () => {
    setLayer(layerKey === 'standard' ? 'cycle' : 'standard');
    toast(`地圖樣式：${TILE_LAYERS[layerKey].label}`);
  });

  const planLayer = L.layerGroup().addTo(map);
  const lineLayer = L.layerGroup().addTo(planLayer);
  const markerLayer = L.layerGroup().addTo(planLayer);

  // Leaflet's corner controls and the map buttons sit above the bottom sheet.
  const planner = $('planner');
  const syncSheet = () => document.documentElement.style.setProperty(
    '--sheet-h', wide.matches ? '0px' : `${planner.offsetHeight}px`,
  );
  new ResizeObserver(syncSheet).observe(planner);
  wide.addEventListener('change', syncSheet);
  setupSheetDrag(planner, $('topbar'), wide);
  // Popups pan the map so they open clear of the search bar and the planner.
  const popupPad = () => (wide.matches
    ? { autoPanPaddingTopLeft: [400, 16], autoPanPaddingBottomRight: [16, 16] }
    : { autoPanPaddingTopLeft: [10, 72], autoPanPaddingBottomRight: [10, planner.offsetHeight + 10] });

  // ---------- plan state ----------
  const savedVehicle = lsGet('mbn.vehicle', 'bicycle');
  const savedPreset = lsGet('mbn.preset', 'balanced');
  const emptyPlan = () => ({
    vehicle: savedVehicle in VEHICLES ? savedVehicle : 'bicycle',
    preset: savedPreset in BIKE_PRESETS ? savedPreset : 'balanced',
    start: null, end: null, vias: [],
    segments: [], // one per pair of points, see segments.js; [] for a saved route without segment data
    line: null, // the chosen line: joinSegments(segments), or a saved route's line
    alts: [], selected: 0, // other lines for a route without via points: segments for segments[0]
    routeId: null, name: '', dirty: false, busy: false, error: null,
  });
  let plan = emptyPlan();
  let planTimer = null;
  let planAbort = null;
  const routePoints = (p) => (p.start && p.end ? [p.start, ...p.vias, p.end] : []);
  const hasSegments = () => plan.line && plan.segments.length > 0 && plan.segments.length === routePoints(plan).length - 1;

  function setPlan(patch) {
    plan = { ...plan, ...patch };
    renderPlanner();
  }

  function cancelPlanning() {
    clearTimeout(planTimer);
    planAbort?.abort();
    planAbort = null;
  }

  /** A change made by the rider: redraw the pins and plan again. Locked segments stay as they are. */
  function editPlan(patch) {
    const next = { ...plan, ...patch };
    // Another vehicle takes other roads, so its route is planned from scratch.
    const vehicleChanged = next.vehicle !== plan.vehicle;
    const old = vehicleChanged ? plan.segments.map((s) => ({ ...s, locked: false })) : plan.segments;
    const carried = carrySegments(routePoints(plan), old, routePoints(next));
    const released = vehicleChanged ? plan.segments.filter((s) => s.locked).length : carried.released;
    if (released > 0) toast(`已解除 ${released} 段固定路線`);
    replan(patch, carried.segments);
  }

  /** Plan the blank segments of `segments` (see planSegments) after the patch is applied. */
  function replan(patch, segments) {
    cancelPlanning();
    setPlan({ ...patch, segments, dirty: true });
    syncMarkers();
    if (segments.length === 0) {
      setPlan({ line: null, alts: [], selected: 0, busy: false, error: null });
      drawLines();
      return;
    }
    setPlan({ busy: true, error: null });
    planTimer = setTimeout(runPlan, 350);
  }

  async function runPlan() {
    const controller = new AbortController();
    planAbort = controller;
    const hadRoute = Boolean(plan.line);
    try {
      const { segments, alternatives } = await planSegments(
        { vehicle: plan.vehicle, preset: plan.preset, points: routePoints(plan), segments: plan.segments },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const alts = alternatives.length > 1 ? alternatives : [];
      setPlan({ segments, line: joinSegments(segments), alts, selected: 0, busy: false, error: null });
      drawLines();
      if (!hadRoute && !nav.active()) fitRoute();
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) return;
      console.error('[plan] failed', err);
      setPlan({
        line: null, alts: [], selected: 0, busy: false,
        error: err instanceof ServiceError ? err.message : '路線規劃失敗，請稍後再試',
      });
      drawLines();
    }
  }

  function toggleLock(k) {
    setPlan({ segments: plan.segments.map((s, j) => (j === k ? { ...s, locked: !s.locked } : s)), dirty: true });
    drawLines();
  }

  /** Walking a segment plans it again, so it is unlocked; the other unlocked segments are planned with it. */
  function toggleWalk(k) {
    replan({}, plan.segments.map((s, j) => {
      if (j === k) return blankSegment(!s.walk);
      return s.locked ? s : blankSegment(s.walk);
    }));
  }

  function currentRoute() {
    const alt = plan.line;
    if (!alt || !plan.start || !plan.end) return null;
    const today = new Date();
    const fallback = `${VEHICLES[plan.vehicle].label}路線 ${today.getMonth() + 1}/${today.getDate()}`;
    return {
      name: plan.name || (plan.start.label && plan.end.label ? `${plan.start.label} → ${plan.end.label}`.slice(0, 80) : fallback),
      vehicle: plan.vehicle,
      preset: plan.preset,
      waypoints: [plan.start, ...plan.vias, plan.end],
      geometry: encodePolyline(alt.coords),
      turns: alt.turns ?? [],
      distance_m: alt.distance_m,
      duration_s: alt.duration_s,
      // undefined (not left out), so updating a saved route also drops its old segment data
      segments: hasSegments() ? segmentMeta(plan.segments, plan.line) : undefined,
    };
  }

  // ---------- map drawing ----------
  function drawLines() {
    lineLayer.clearLayers();
    plan.alts.forEach((alt, i) => {
      if (i === plan.selected) return;
      const line = L.polyline(alt.coords, { color: '#7a7f8a', weight: 6, opacity: 0.75, lineJoin: 'round' }).addTo(lineLayer);
      line.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        selectAlt(i);
      });
    });
    const main = plan.line;
    if (!main) return;
    // Not interactive, so a tap on the line reaches the map and can add a via point there.
    L.polyline(main.coords, { color: '#fff', weight: 11, opacity: 0.9, interactive: false, lineJoin: 'round' }).addTo(lineLayer);
    if (!hasSegments()) {
      L.polyline(main.coords, segmentStyle(null)).addTo(lineLayer);
      return;
    }
    plan.segments.forEach((s, k) => {
      const from = k === 0 ? 0 : main.ends[k - 1];
      L.polyline(main.coords.slice(from, main.ends[k] + 1), segmentStyle(s)).addTo(lineLayer);
    });
  }

  function selectAlt(index) {
    if (index === plan.selected) return;
    const segments = [{ ...plan.alts[index], locked: plan.segments[0].locked }];
    setPlan({ selected: index, segments, line: joinSegments(segments), dirty: true });
    drawLines();
  }

  // The point goes in the middle of the map left clear by the search bar and the planner.
  function showPoint(latlng, zoom) {
    const size = map.getSize();
    const sheet = planner.getBoundingClientRect();
    const box = {
      left: wide.matches ? sheet.right : 0,
      top: $('topbar').getBoundingClientRect().bottom,
      right: size.x,
      bottom: wide.matches ? size.y : sheet.top,
    };
    map.setView(centerFor(map, latlng, zoom, box), zoom);
  }

  function fitRoute() {
    const alt = plan.line;
    if (!alt) return;
    map.fitBounds(L.latLngBounds(alt.coords), {
      paddingTopLeft: [wide.matches ? 410 : 24, 76],
      paddingBottomRight: [24, (wide.matches ? 0 : planner.offsetHeight) + 24],
    });
  }

  function syncMarkers() {
    markerLayer.clearLayers();
    // apply(point) moves the pin, apply(null) removes it.
    const add = (point, kind, n, title, apply) => {
      if (!point) return;
      const marker = L.marker([point.lat, point.lon], { icon: pinIcon(kind, n), draggable: true, autoPan: true }).addTo(markerLayer);
      marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        apply(makePoint(lat, lng));
      });
      marker.on('click', () => {
        const content = h('div', { class: 'pop' },
          h('strong', null, `${title}：${labelOf(point)}`),
          h('button', { type: 'button', class: 'danger', onclick: () => { map.closePopup(); apply(null); } }, `移除${title}`),
          h('small', null, '長按拖曳可以移動位置'),
        );
        L.popup({ offset: [0, -34], ...popupPad() }).setLatLng(marker.getLatLng()).setContent(content).openOn(map);
      });
    };
    add(plan.start, 'start', 0, '起點', (p) => editPlan({ start: p }));
    plan.vias.forEach((via, i) => add(via, 'via', i + 1, `中途點 ${i + 1}`, (p) => editPlan({
      vias: p ? plan.vias.map((v, j) => (j === i ? p : v)) : plan.vias.filter((_, j) => j !== i),
    })));
    add(plan.end, 'end', 0, '終點', (p) => editPlan({ end: p }));
  }

  /**
   * Put a new via point where it falls along a line (the current one unless given; at = metres along
   * it, if known), so the route does not double back.
   */
  function insertVia(point, at = null, coords = plan.line?.coords) {
    if (!coords) return [...plan.vias, point];
    const index = viaSlot(coords, plan.vias, point, at);
    return [...plan.vias.slice(0, index), point, ...plan.vias.slice(index)];
  }

  function openPointPopup(latlng, label) {
    const point = makePoint(latlng.lat, latlng.lng, label);
    const choose = (makePatch) => () => {
      map.closePopup();
      editPlan(makePatch());
    };
    const addVia = () => {
      map.closePopup();
      if (plan.vias.length >= MAX_VIAS) {
        toast(`中途點最多 ${MAX_VIAS} 個`, 'error');
        return;
      }
      editPlan({ vias: insertVia(point) });
    };
    const content = h('div', { class: 'pop' },
      h('strong', null, labelOf(point)),
      h('button', { type: 'button', onclick: choose(() => ({ start: point })) }, '🐱 設為起點'),
      plan.start && plan.end && h('button', { type: 'button', onclick: addVia }, '🟠 加入中途點'),
      h('button', { type: 'button', onclick: choose(() => ({ end: point })) }, '🐟 設為終點'),
    );
    L.popup(popupPad()).setLatLng(latlng).setContent(content).openOn(map);
  }

  // ---------- planner sheet ----------
  function renderPlanner() {
    const alt = plan.line;
    const ready = Boolean(alt) && !plan.busy;
    const anything = plan.start || plan.end || plan.vias.length > 0;

    let summary;
    if (plan.busy) summary = [cat('think'), h('span', { class: 'hint' }, '喵魔人找路中…')];
    else if (plan.error) summary = [cat('surprise'), h('span', { class: 'err' }, plan.error)];
    else if (alt) {
      summary = [h('div', null,
        h('span', { class: 'big' }, `${formatDistance(alt.distance_m)} · ${formatDuration(alt.duration_s)}`),
        plan.name && h('span', { class: 'name' }, plan.dirty ? `${plan.name}（已修改，尚未儲存）` : plan.name),
      )];
    } else {
      const hint = !plan.start && !plan.end ? '點地圖或搜尋地點，設定起點與終點' : !plan.start ? '再設定起點' : '再設定終點';
      summary = [h('span', { class: 'hint' }, hint)];
    }

    const chip = (on, onclick, ...children) => h('button', { type: 'button', class: on ? 'chip on' : 'chip', onclick }, children);
    const pointRow = (tag, point, onRemove, extra) => h('div', { class: point ? 'point' : 'point missing' },
      h('span', { class: 'tag' }, tag),
      h('span', { class: 'label' }, point ? labelOf(point) : '點地圖設定'),
      point ? h('button', { type: 'button', 'aria-label': `移除${tag}`, onclick: onRemove }, '✕') : extra,
    );
    const points = routePoints(plan);
    const showSegments = plan.segments.length > 0 && plan.segments.length === points.length - 1;
    const segRow = (k) => showSegments && segmentRow(plan.segments[k], {
      from: points[k], to: points[k + 1], bike: plan.vehicle === 'bicycle',
      onLock: () => toggleLock(k), onWalk: () => toggleWalk(k),
    });

    planner.replaceChildren(...[
      h('button', {
        type: 'button', class: 'handle', 'aria-label': '收合或展開',
        onclick: () => planner.classList.toggle('collapsed'),
      }),
      h('div', { class: 'summary' }, summary),
      h('div', { class: 'chips fold' }, Object.entries(VEHICLES).map(([key, v]) => chip(plan.vehicle === key, () => {
        if (plan.vehicle === key) return;
        lsSet('mbn.vehicle', key);
        editPlan({ vehicle: key });
      }, `${v.icon} ${v.label}`))),
      plan.vehicle === 'bicycle' && h('div', { class: 'chips fold' }, Object.entries(BIKE_PRESETS).map(([key, p]) => chip(plan.preset === key, () => {
        if (plan.preset === key) return;
        lsSet('mbn.preset', key);
        editPlan({ preset: key });
      }, p.label))),
      plan.alts.length > 1 && h('div', { class: 'chips fold' }, plan.alts.map((a, i) => chip(i === plan.selected, () => selectAlt(i),
        `路線 ${i + 1}`, h('small', null, `${formatDistance(a.distance_m)}・${formatDuration(a.duration_s)}`)))),
      h('div', { class: 'points fold' },
        pointRow('起點', plan.start, () => editPlan({ start: null }),
          h('button', { type: 'button', onclick: () => locate((lat, lon) => editPlan({ start: makePoint(lat, lon, '我的位置') })) }, '📍 用目前位置')),
        segRow(0),
        plan.vias.flatMap((via, i) => [
          pointRow(`中途點 ${i + 1}`, via, () => editPlan({ vias: plan.vias.filter((_, j) => j !== i) })),
          segRow(i + 1),
        ]),
        pointRow('終點', plan.end, () => editPlan({ end: null })),
      ),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'primary', disabled: !ready, onclick: () => startNav(currentRoute(), false, true) }, '開始導航'),
        h('button', { type: 'button', class: 'dark', disabled: !ready, onclick: () => startNav(currentRoute(), true, true) }, '反向導航'),
      ),
      h('div', { class: 'actions fold' },
        h('button', { type: 'button', disabled: !ready, onclick: saveRoute }, '儲存'),
        h('button', { type: 'button', disabled: !ready, onclick: () => exportRoute(currentRoute()) }, '匯出 GPX'),
        h('button', { type: 'button', disabled: !anything, onclick: clearPlan }, '清除'),
      ),
    ].filter(Boolean));
  }

  async function confirmDiscard() {
    if (!plan.dirty || !plan.line) return true;
    const answer = await dialog({
      title: '目前的路線還沒儲存',
      message: '要放棄這次的修改嗎？',
      buttons: [{ label: '放棄修改', value: 'discard', danger: true }, { label: '回去儲存', value: null, primary: true }],
    });
    return answer.value === 'discard';
  }

  async function clearPlan() {
    if (!(await confirmDiscard())) return;
    cancelPlanning();
    map.closePopup();
    plan = { ...emptyPlan(), vehicle: plan.vehicle, preset: plan.preset };
    renderPlanner();
    syncMarkers();
    drawLines();
  }

  async function saveRoute() {
    const route = currentRoute();
    if (!route) return;
    const existing = plan.routeId != null;
    const answer = await dialog({
      title: '儲存路線',
      input: { value: route.name, placeholder: '路線名稱' },
      buttons: existing
        ? [{ label: '覆蓋原路線', value: 'update', primary: true }, { label: '另存新路線', value: 'create' }, { label: '取消', value: null }]
        : [{ label: '儲存', value: 'create', primary: true }, { label: '取消', value: null }],
    });
    if (!answer.value) return;
    const named = { ...route, name: answer.text || route.name };
    try {
      const id = answer.value === 'update' ? await routeStore.update(plan.routeId, named) : await routeStore.create(named);
      setPlan({ routeId: id, name: named.name, dirty: false });
      toast(routeStore.mode === 'folder' ? `已存到資料夾「${routeStore.folderName}」` : '已儲存到「我的路線」');
    } catch (err) {
      console.error('[save] failed', err);
      toast(err.message, 'error');
    }
  }

  async function exportRoute(route) {
    if (!route) return;
    const outcome = await shareOrDownload(`${fileSafe(route.name)}.gpx`, routeToGpx(route), 'application/gpx+xml');
    if (outcome === 'downloaded') toast('已下載 GPX 檔，可以上傳到雲端硬碟備份');
  }

  // ---------- saved routes drawer ----------
  /** { segments, line } of a saved route. Routes saved before segments existed keep one plain line. */
  function savedLine(route, pointCount) {
    const coords = decodePolyline(route.geometry);
    const turns = route.turns ?? [];
    const meta = cleanSegmentMeta(route.segments, pointCount, coords.length);
    if (!meta) return { segments: [], line: { coords, turns, distance_m: route.distance_m, duration_s: route.duration_s, ends: [] } };
    const segments = splitLine(coords, turns, meta);
    return { segments, line: joinSegments(segments) };
  }

  async function openSaved(id) {
    loadRoute(await routeStore.get(id), id);
    closeDrawer();
    fitRoute();
  }

  function loadRoute(route, id) {
    const points = route.waypoints.map((p) => makePoint(p.lat, p.lon, p.label));
    cancelPlanning();
    map.closePopup();
    plan = {
      ...emptyPlan(),
      vehicle: route.vehicle in VEHICLES ? route.vehicle : 'bicycle',
      preset: route.preset in BIKE_PRESETS ? route.preset : 'balanced',
      start: points[0],
      end: points[points.length - 1],
      vias: points.slice(1, -1),
      // The stored line is shown as it was saved; only unlocked segments are planned again after an edit.
      ...savedLine(route, points.length),
      routeId: id,
      name: route.name,
    };
    renderPlanner();
    syncMarkers();
    drawLines();
  }

  /** Run a drawer action; storage errors are shown instead of being lost. */
  const guarded = (action) => async () => {
    try {
      await action();
    } catch (err) {
      console.error('[routes] action failed', err);
      toast(err.message || '操作失敗', 'error');
    }
  };

  let renderSeq = 0;
  async function renderRoutes() {
    const seq = ++renderSeq;
    const box = $('route-list');
    renderStorage();
    if (folderState === 'prompt' || folderState === 'denied') {
      box.replaceChildren(h('div', { class: 'empty' }, cat('think'), `需要你允許，才能讀取資料夾「${folderHandle.name}」裡的路線。`));
      return;
    }
    let routes;
    let broken = [];
    try {
      if (routeStore.mode === 'folder') ({ routes, broken } = await routeStore.scan());
      else routes = await routeStore.list();
    } catch (err) {
      console.error('[routes] cannot list', err);
      if (seq === renderSeq) box.replaceChildren(h('div', { class: 'empty' }, cat('surprise'), err.message));
      return;
    }
    if (seq !== renderSeq) return;
    const skipped = broken.length > 0
      && h('p', { class: 'note' }, `有 ${broken.length} 個 GPX 檔讀不出路線，已略過：${broken.join('、')}`);
    if (routes.length === 0) {
      box.replaceChildren(h('div', { class: 'empty' }, cat('read'), routeStore.mode === 'folder'
        ? '資料夾裡還沒有路線。規劃好路線後按「儲存」，或把 GPX 檔放進這個資料夾。'
        : '還沒有儲存的路線。規劃好路線後按「儲存」，或匯入路線檔。'), skipped || '');
      return;
    }
    const small = (label, onclick, cls) => h('button', { type: 'button', class: cls ?? '', onclick: guarded(onclick) }, label);
    box.replaceChildren(...routes.map((r) => h('div', { class: 'route-card' },
      h('button', {
        type: 'button', class: 'title',
        onclick: guarded(async () => { if (await confirmDiscard()) openSaved(r.id); }),
      },
        h('strong', null, r.name),
        h('small', null, `${(VEHICLES[r.vehicle] ?? VEHICLES.bicycle).icon} ${formatDistance(r.distance_m)} · ${formatDuration(r.duration_s)}`),
      ),
      h('div', { class: 'row' },
        small('導航', async () => { const route = await routeStore.get(r.id); closeDrawer(); startNav(route, false); }, 'primary'),
        small('反向導航', async () => { const route = await routeStore.get(r.id); closeDrawer(); startNav(route, true); }, 'dark'),
        small('匯出', async () => exportRoute(await routeStore.get(r.id))),
        small('改名', async () => {
          const answer = await dialog({
            title: '修改路線名稱',
            input: { value: r.name, placeholder: '路線名稱' },
            buttons: [{ label: '儲存', value: 'ok', primary: true }, { label: '取消', value: null }],
          });
          if (!answer.value || !answer.text) return;
          const id = await routeStore.update(r.id, { name: answer.text });
          if (plan.routeId === r.id) setPlan({ routeId: id, name: answer.text });
          await renderRoutes();
        }),
        small('刪除', async () => {
          const answer = await dialog({
            title: `刪除「${r.name}」？`,
            message: routeStore.mode === 'folder'
              ? `會刪除資料夾裡的「${r.id}」檔案，無法復原。需要保留的話請先匯出。`
              : '刪除後無法復原。需要保留的話請先匯出。',
            buttons: [{ label: '刪除', value: 'delete', danger: true }, { label: '取消', value: null, primary: true }],
          });
          if (answer.value !== 'delete') return;
          await routeStore.remove(r.id);
          if (plan.routeId === r.id) setPlan({ routeId: null });
          await renderRoutes();
        }, 'danger'),
      ),
    )), skipped || '');
  }

  // ---------- where routes are kept: this browser, or a folder on the phone ----------
  const localStore = {
    mode: 'local',
    list: async () => store.list(),
    getAll: async () => store.getAll(),
    get: async (id) => store.get(id),
    create: async (route) => store.create(route),
    update: async (id, patch) => { store.update(id, patch); return id; },
    remove: async (id) => store.remove(id),
  };
  let routeStore = localStore;
  let folderHandle = null;
  let folderState = 'none'; // 'none' | 'granted' | 'prompt' | 'denied'

  function useFolder(handle, state) {
    folderHandle = handle;
    folderState = handle ? state : 'none';
    routeStore = handle && state === 'granted' ? folderStore(handle) : localStore;
    // Ids belong to one place, so an opened route is no longer "saved" after switching.
    if (plan.routeId != null) setPlan({ routeId: null, dirty: Boolean(plan.line) });
  }

  function renderStorage() {
    const box = $('storage');
    const button = (label, onclick, cls) => h('button', { type: 'button', class: cls ?? '', onclick: guarded(onclick) }, label);
    if (!folderSupported) {
      box.replaceChildren(h('p', { class: 'note' }, '路線存在這個瀏覽器裡。這個瀏覽器（例如 iPhone、Firefox）不能指定手機資料夾，請用匯出檔案備份。'));
      return;
    }
    if (!folderHandle) {
      box.replaceChildren(
        h('p', { class: 'note' }, '目前存在這個瀏覽器裡。也可以改存到手機的資料夾，一條路線一個 GPX 檔；選雲端同步的資料夾就能跨裝置同步。'),
        h('div', { class: 'drawer-actions' }, button('📁 改存到手機資料夾', chooseFolder)),
      );
      return;
    }
    const granted = folderState === 'granted';
    box.replaceChildren(
      h('div', { class: 'folder-bar' },
        h('strong', null, `📁 ${folderHandle.name}`),
        h('small', null, granted ? '路線存在這個資料夾' : '瀏覽器需要你再允許一次存取'),
      ),
      h('div', { class: 'drawer-actions' },
        granted ? button('重新整理', renderRoutes) : button('允許存取', allowFolder, 'primary'),
        button('換資料夾', chooseFolder),
        button('改回存在瀏覽器', leaveFolder),
      ),
    );
  }

  async function chooseFolder() {
    let handle;
    try {
      handle = await pickFolder();
    } catch (err) {
      if (err.name === 'AbortError') return; // the rider closed the picker
      throw err;
    }
    await connectFolder(handle);
  }

  /** Switch to a folder (handle already granted), offering to copy the routes kept in this browser. */
  async function connectFolder(handle) {
    const state = await folderAccess(handle, true);
    if (state !== 'granted') throw new Error('沒有取得資料夾的讀寫權限');
    await rememberFolder(handle);
    useFolder(handle, 'granted');
    const local = store.getAll();
    if (local.length > 0) {
      const answer = await dialog({
        title: '複製現有路線？',
        message: `瀏覽器裡有 ${local.length} 條路線，要複製成 GPX 檔放進「${handle.name}」嗎？瀏覽器裡的仍會保留。`,
        buttons: [{ label: '複製', value: 'copy', primary: true }, { label: '不用', value: null }],
      });
      if (answer.value === 'copy') {
        for (const route of local) await routeStore.create(route);
        toast(`已複製 ${local.length} 條路線到「${handle.name}」`);
      }
    }
    await renderRoutes();
  }

  async function allowFolder() {
    const state = await folderAccess(folderHandle, true);
    useFolder(folderHandle, state);
    if (state !== 'granted') toast('沒有取得資料夾的存取權限', 'error');
    await renderRoutes();
  }

  async function leaveFolder() {
    const answer = await dialog({
      title: '改回存在瀏覽器？',
      message: `資料夾「${folderHandle.name}」裡的檔案不會被刪除，之後可以再選回來。`,
      buttons: [{ label: '改回瀏覽器', value: 'leave', primary: true }, { label: '取消', value: null }],
    });
    if (answer.value !== 'leave') return;
    await rememberFolder(null);
    useFolder(null);
    await renderRoutes();
  }

  // Reconnect to last time's folder. Phones usually ask again after the browser restarts.
  const folderReady = (async () => {
    if (!folderSupported) return;
    const handle = await savedFolder();
    if (!handle) return;
    try {
      useFolder(handle, await folderAccess(handle));
    } catch (err) {
      console.error('[folder] cannot check saved folder', err);
      useFolder(handle, 'prompt');
    }
  })();

  function openDrawer() {
    folderReady.then(renderRoutes);
    $('drawer').hidden = false;
    $('scrim').hidden = false;
  }
  function closeDrawer() {
    $('drawer').hidden = true;
    $('scrim').hidden = true;
  }
  $('btn-menu').addEventListener('click', openDrawer);
  $('btn-drawer-close').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);

  /** files: [{ name, text }]. Every route in every file becomes a new saved route. */
  async function importTexts(files) {
    const imported = [];
    const failures = [];
    for (const file of files) {
      try {
        for (const route of parseRouteFile(file.text, file.name)) imported.push(await routeStore.create(route));
      } catch (err) {
        console.error('[import] failed', file.name, err);
        failures.push(`${file.name}：${err.message}`);
      }
    }
    await renderRoutes();
    if (failures.length > 0) {
      toast(`${imported.length > 0 ? `已匯入 ${imported.length} 條。` : ''}無法匯入 ${failures.join('；')}`, 'error');
    } else if (imported.length > 0) {
      toast(`已匯入 ${imported.length} 條路線`);
    }
    return imported;
  }

  $('btn-import').addEventListener('click', guarded(async () => {
    const files = await pickFiles();
    if (files.length === 0) return;
    const tooBig = files.find((file) => file.size > 20e6);
    if (tooBig) throw new Error(`${tooBig.name} 超過 20 MB，無法匯入`);
    await importTexts(await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() }))));
  }));

  $('btn-backup').addEventListener('click', guarded(async () => {
    const routes = await routeStore.getAll();
    if (routes.length === 0) {
      toast('還沒有可以備份的路線');
      return;
    }
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const outcome = await shareOrDownload(`MeowBikeNavi-backup-${stamp}.json`, backupJson(routes), 'application/json');
    if (outcome === 'downloaded') toast(`已下載 ${routes.length} 條路線的備份檔`);
  }));

  // ---------- search ----------
  const { hide: hideResults } = setupSearch((place) => {
    showPoint(L.latLng(place.lat, place.lon), 16);
    openPointPopup(L.latLng(place.lat, place.lon), place.name);
  });

  // ---------- my location ----------
  let meMarker = null;
  function locate(then) {
    if (!('geolocation' in navigator)) {
      toast('這個瀏覽器不支援定位', 'error');
      return;
    }
    toast('定位中…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        if (meMarker) map.removeLayer(meMarker);
        meMarker = L.circleMarker([lat, lon], {
          radius: 8, color: '#fff', weight: 3, fillColor: '#2f7fe0', fillOpacity: 1, interactive: false,
        });
        if (!nav.active()) meMarker.addTo(map);
        $('toast').hidden = true;
        then(lat, lon);
      },
      (err) => {
        console.warn('[locate] failed', err.code, err.message);
        toast(geoErrorText(err), 'error');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    );
  }
  $('btn-locate').addEventListener('click', () => locate((lat, lon) => showPoint(L.latLng(lat, lon), Math.max(map.getZoom(), 16))));

  const voice = setupVoice({ sim: SIM });

  // ---------- navigation ----------
  const nav = createNavigator(map, {
    onStart: () => {
      map.closePopup();
      hideResults();
      map.removeLayer(planLayer);
      if (meMarker) map.removeLayer(meMarker);
    },
    onStop: () => planLayer.addTo(map),
    onMark: (mark) => markHere(mark).catch((err) => {
      console.error('[nav] cannot add via point', err);
      toast('無法加入中途點，請稍後再試', 'error');
    }),
    voice,
  });

  // fromPlan: the route is the planner's current plan, so it can be edited while riding.
  let navFromPlan = false;
  function startNav(route, reverse, fromPlan = false) {
    navFromPlan = fromPlan;
    nav.start(route, reverse);
  }

  /** The rider's position while navigating becomes a via point; the route is planned again and navigation carries on. */
  async function markHere({ position: [lat, lon], along, route }) {
    if (!navFromPlan) {
      // A saved or resumed route: it goes into the planner first, so the change can be saved later.
      if (!(await confirmDiscard())) return;
      cancelPlanning();
      loadRoute(route, route.id ?? null);
      navFromPlan = true;
    }
    if (plan.vias.length >= MAX_VIAS) {
      toast(`中途點最多 ${MAX_VIAS} 個`, 'error');
      return;
    }
    if (routePoints(plan).some((p) => haversine([p.lat, p.lon], [lat, lon]) < 20)) {
      toast('這裡已經有路線的點了');
      return;
    }
    const time = new Date().toTimeString().slice(0, 5);
    const point = makePoint(lat, lon, `導航中加入 ${time}`);
    // along was measured on the line being ridden, which the planner's line may not be after a failed plan.
    editPlan({ vias: insertVia(point, along, decodePolyline(route.geometry)) });
    clearTimeout(planTimer); // the rider is waiting: plan now instead of after the usual pause
    await runPlan();
    const i = plan.vias.indexOf(point);
    if (!nav.active() || i < 0) return;
    if (!plan.line || plan.error) {
      toast(`已加入中途點 ${i + 1}，但${plan.error ?? '路線規劃失敗'}。繼續沿原路線導航`, 'error');
      return;
    }
    nav.update(currentRoute(), cumulative(plan.line.coords)[plan.line.ends[i]]);
    toast(`已加入中途點 ${i + 1}，路線已更新。結束導航後記得儲存`);
  }

  map.on('click', (event) => {
    if (nav.active()) return;
    hideResults();
    openPointPopup(event.latlng);
  });
  map.on('moveend', () => {
    if (nav.active()) return;
    const center = map.getCenter();
    lsSet('mbn.view', { center: [center.lat, center.lng], zoom: map.getZoom() });
  });

  renderPlanner();
  syncSheet();
  if (SIM) {
    window.__mbnImport = importTexts;
    window.__mbnMap = map;
    // Tests use the browser's private folder, since the folder picker needs a real tap.
    window.__mbnUseFolder = async (handle) => { await folderReady; await connectFolder(handle); };
  }

  const pending = nav.pending();
  if (pending) {
    dialog({
      image: 'img/cat-hello.webp',
      title: '上次的導航還沒結束',
      message: `${pending.route.name ?? ''}\n要繼續導航嗎？`,
      buttons: [{ label: '繼續導航', value: 'resume', primary: true }, { label: '不用了', value: null }],
    }).then((answer) => {
      if (answer.value === 'resume') startNav(pending.route, Boolean(pending.reverse));
      else nav.forget();
    });
  }
}
