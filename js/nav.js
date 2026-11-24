// Navigation along a fixed line. The line is never re-planned: when the rider leaves it, an arrow
// shows the way back and the rider finds their own path. Turns saved with the route are shown and
// spoken ahead of time while the rider is on the line.
import { VEHICLES } from './config.js';
import { decodePolyline, bearing, compassText, formatDistance, formatDuration } from './geo.js';
import { makeLine, advance, START } from './track.js';
import { placeTurns, reverseTurns, cueLimits, nextTurn, nextCue, cueText, turnText } from './turns.js';
import { toast, dialog, lsGet, lsSet, geoErrorText } from './ui.js';
import { pinIcon, userIcon } from './icons.js';
import { centerFor } from './view.js';
import { setupHudDrag } from './hud-drag.js';

const L = window.L;
const NAV_KEY = 'mbn.nav';
// ?sim in the address: tap the map to fake the GPS position (for testing indoors).
const SIM = new URLSearchParams(location.search).has('sim');

// Turn arrows drawn for a right-hand turn; left-hand ones are mirrored.
const ARROW = {
  straight: 'M12 21V4 M7 9l5-5 5 5',
  right: 'M7 21V11a3 3 0 0 1 3-3h8 M14 4l4 4-4 4',
  slight: 'M8 21v-6.5L16 6.5 M10.5 6h6v6',
  sharp: 'M7 21V6l10 10 M17 10v6h-6',
  uturn: 'M7 21V9a4.5 4.5 0 0 1 9 0v8 M12.5 13.5l3.5 3.5 3.5-3.5',
  roundabout: 'M12 14.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M12 21v-6.5',
};
// kind -> [shape, mirrored]. Traffic keeps right here, so a U-turn is drawn to the left.
const ARROW_OF = {
  right: ['right', false], left: ['right', true], slight_right: ['slight', false], slight_left: ['slight', true],
  sharp_right: ['sharp', false], sharp_left: ['sharp', true], keep_right: ['slight', false], keep_left: ['slight', true],
  uturn: ['uturn', true], rb_in: ['roundabout', false], rb_out: ['roundabout', false],
};

/** voice: { say(text), stop() } from app.js; it stays quiet when the rider turned prompts off. */
export function createNavigator(map, { onStart, onStop, voice } = {}) {
  const $ = (id) => document.getElementById(id);
  const el = {
    hud: $('nav-hud'), remaining: $('nav-remaining'), sub: $('nav-sub'), off: $('nav-off'),
    offTitle: $('nav-off-title'), offHint: $('nav-off-hint'), offArrow: $('nav-off-arrow'),
    turn: $('nav-turn'), turnPath: $('nav-turn-path'), turnIcon: $('nav-turn-icon'),
    turnDist: $('nav-turn-dist'), turnText: $('nav-turn-text'),
    recenter: $('btn-recenter'), stop: $('btn-stop'), cards: $('nav-cards'), bottom: $('nav-bottom'),
  };
  let s = null; // the active session, null when not navigating
  const say = (text) => voice?.say(text);

  // The rider is kept in the larger clear part of the map, above or below the cards.
  function clearBox() {
    const size = map.getSize();
    const cards = el.cards.getBoundingClientRect();
    const floor = el.bottom.getBoundingClientRect().top;
    const above = { left: 0, top: 0, right: size.x, bottom: cards.top };
    const below = { left: 0, top: cards.bottom, right: size.x, bottom: floor };
    return above.bottom - above.top > below.bottom - below.top ? above : below;
  }
  const followCenter = (p, zoom) => centerFor(map, p, zoom, clearBox());

  setupHudDrag(el.cards, el.bottom, {
    onMoved: () => {
      if (s?.follow && s.track.position) map.panTo(followCenter(s.track.position, map.getZoom()), { animate: true, duration: 0.3 });
    },
  });

  function renderTurn() {
    const t = s.track;
    el.turn.hidden = s.turns.length === 0 || t.along == null;
    if (el.turn.hidden) return;
    const next = nextTurn(s.turns, t.along);
    const [shape, mirrored] = next ? ARROW_OF[next.turn.k] : ['straight', false];
    el.turnPath.setAttribute('d', ARROW[shape]);
    el.turnIcon.style.transform = mirrored ? 'scaleX(-1)' : '';
    el.turnDist.textContent = next ? formatDistance(next.dist) : formatDistance(t.remaining);
    el.turnText.textContent = next ? turnText(next.turn) : '直行到終點';
  }

  function renderHud() {
    const t = s.track;
    renderTurn();
    if (!t.position) {
      el.remaining.textContent = s.gpsError ? '無法定位' : '等待 GPS 定位…';
      el.sub.textContent = s.gpsError ?? (SIM ? '模擬模式：點地圖模擬目前位置' : '請允許定位，並保持螢幕開啟');
      return;
    }
    el.remaining.textContent = `剩餘 ${formatDistance(t.remaining)}`;
    el.sub.textContent = [
      s.reverse && '反向',
      `約 ${formatDuration(t.remaining / s.speed)}`,
      s.gpsError ?? `GPS 誤差 ${Math.round(s.accuracy)} 公尺`,
      s.awake === false && '請手動保持螢幕開啟',
    ].filter(Boolean).join(' · ');
  }

  function onFix(fix) {
    if (!s || s.done) return;
    const wasOff = s.track.off;
    const t = advance(s.track, s.line, fix);
    s.track = t;
    s.accuracy = fix.accuracy;
    s.gpsError = null;
    const p = t.position;

    if (!s.user) {
      s.user = L.marker(p, { icon: userIcon(), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(s.layers);
    } else {
      s.user.setLatLng(p);
    }
    const root = s.user.getElement();
    const cone = root.querySelector('.user-cone');
    const back = root.querySelector('.user-back');
    const heading = Number.isFinite(fix.heading) ? fix.heading : null;
    cone.hidden = heading == null;
    if (heading != null) cone.style.transform = `rotate(${heading}deg)`;

    if (t.off) {
      // The map is north-up, so a compass bearing is also the direction on screen.
      const dir = bearing(p, t.target.point);
      back.style.transform = `rotate(${dir}deg)`;
      el.offArrow.style.transform = `rotate(${dir}deg)`;
      el.offTitle.textContent = `偏離路線 ${formatDistance(t.target.distance)}`;
      el.offHint.textContent = `往${compassText(dir)}方回到路線（路線不會改變）`;
      s.guide.setLatLngs([p, t.target.point]);
    } else {
      s.guide.setLatLngs([]);
      if (t.along === t.snapped.along) {
        s.passed.setLatLngs([...s.line.coords.slice(0, t.snapped.index + 1), t.snapped.point]);
      }
    }
    back.hidden = !t.off;
    el.off.hidden = !t.off;

    if (s.follow) {
      // No zoom animation: a fix arriving mid-animation would have its pan dropped.
      if (s.fixes === 0) {
        const zoom = Math.max(map.getZoom(), 17);
        map.setView(followCenter(p, zoom), zoom, { animate: false });
      } else {
        map.panTo(followCenter(p, map.getZoom()), { animate: true, duration: 0.5 });
      }
    }
    s.fixes += 1;
    renderHud();

    if (t.arrived) {
      s.done = true;
      say('抵達終點');
      dialog({
        image: 'img/cat-cheer.webp',
        title: '抵達終點！',
        message: `${s.route.name}\n全程 ${formatDistance(s.line.total)}`,
        buttons: [{ label: '結束導航', value: 'stop', primary: true }],
      }).then(stop);
      return;
    }

    if (t.off && !wasOff) say('已偏離路線，請依箭頭方向回到路線');
    else if (!t.off && wasOff) say('已回到路線');
    else if (!t.off && t.along === t.snapped.along) {
      // Only while progress follows the rider: a fix that snapped behind would repeat old prompts.
      const cue = nextCue(s.turns, t.along, s.said, s.limits);
      if (cue) {
        s.said = cue.said;
        say(cueText(cue));
      }
    }
  }

  function watch() {
    if (SIM) return;
    if (!('geolocation' in navigator)) {
      s.gpsError = '這個瀏覽器不支援定位';
      renderHud();
      return;
    }
    if (s.watchId != null) navigator.geolocation.clearWatch(s.watchId);
    s.watchId = navigator.geolocation.watchPosition(
      (pos) => onFix({
        lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, heading: pos.coords.heading,
      }),
      (err) => {
        console.warn('[nav] geolocation error', err.code, err.message);
        if (!s) return;
        s.gpsError = geoErrorText(err);
        renderHud();
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 },
    );
  }

  async function keepAwake() {
    if (!s) return;
    if (!('wakeLock' in navigator)) {
      s.awake = false;
      renderHud();
      return;
    }
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!s) {
        await lock.release();
        return;
      }
      s.wakeLock = lock;
      s.awake = true;
    } catch (err) {
      console.warn('[nav] wake lock refused', err);
      if (!s) return;
      s.awake = false;
    }
    renderHud();
  }

  function start(route, reverse) {
    stop();
    const base = decodePolyline(route.geometry);
    if (base.length < 2) {
      toast('這條路線沒有座標，無法導航', 'error');
      return;
    }
    // Reverse: the same line walked backwards, start and end swapped.
    const line = makeLine(reverse ? base.slice().reverse() : base);
    const waypoints = reverse ? route.waypoints.slice().reverse() : route.waypoints;
    const layers = L.layerGroup().addTo(map);
    const lineOptions = { interactive: false, lineJoin: 'round' };
    L.polyline(line.coords, { ...lineOptions, color: '#fff', weight: 11, opacity: 0.9 }).addTo(layers);
    L.polyline(line.coords, { ...lineOptions, color: '#f08a3c', weight: 6 }).addTo(layers);
    const passed = L.polyline([], { ...lineOptions, color: '#8d8a84', weight: 6 }).addTo(layers);
    const guide = L.polyline([], { ...lineOptions, color: '#1f1f24', weight: 3, dashArray: '4 9' }).addTo(layers);
    waypoints.forEach((p, i) => {
      const kind = i === 0 ? 'start' : i === waypoints.length - 1 ? 'end' : 'via';
      L.marker([p.lat, p.lon], { icon: pinIcon(kind, i), interactive: false, keyboard: false }).addTo(layers);
    });

    const planned = route.distance_m > 0 && route.duration_s > 0;
    const speed = planned ? route.distance_m / route.duration_s : (VEHICLES[route.vehicle] ?? VEHICLES.bicycle).kmh / 3.6;
    const saved = route.turns ?? [];
    s = {
      route, reverse, line, layers, passed, guide, speed,
      turns: placeTurns(reverse ? reverseTurns(saved, base.length) : saved, line),
      said: {}, limits: cueLimits(speed),
      track: START, user: null, follow: true, fixes: 0, accuracy: null, gpsError: null,
      watchId: null, wakeLock: null, awake: null, done: false,
    };
    lsSet(NAV_KEY, { route, reverse }); // lets a reloaded page offer to continue
    document.body.classList.add('navigating');
    el.hud.hidden = false;
    el.off.hidden = true;
    el.recenter.hidden = true;
    onStart?.();
    renderHud();
    const box = clearBox();
    map.fitBounds(L.latLngBounds(line.coords), {
      paddingTopLeft: [30, box.top + 20],
      paddingBottomRight: [30, map.getSize().y - box.bottom + 20],
    });
    watch();
    keepAwake();
    // Called from a tap, which lets iOS start speech at all.
    say(`${reverse ? '開始反向導航' : '開始導航'}，全程 ${formatDistance(line.total)}`);
    const notes = [
      reverse && '反向導航：路線與原本相同，遇到單行道請自行判斷',
      s.turns.length === 0 && '這條路線沒有轉彎資料，只會提醒偏離路線與抵達',
    ].filter(Boolean);
    if (notes.length > 0) toast(notes.join('。'));
  }

  function stop() {
    if (!s) return;
    voice?.stop();
    if (s.watchId != null) navigator.geolocation.clearWatch(s.watchId);
    s.wakeLock?.release().catch((err) => console.warn('[nav] wake lock release failed', err));
    map.removeLayer(s.layers);
    s = null;
    lsSet(NAV_KEY, null);
    document.body.classList.remove('navigating');
    el.hud.hidden = true;
    onStop?.();
  }

  el.stop.addEventListener('click', async () => {
    const answer = await dialog({
      title: '要結束導航嗎？',
      buttons: [{ label: '結束導航', value: 'stop', primary: true }, { label: '繼續騎', value: null }],
    });
    if (answer.value) stop();
  });
  el.recenter.addEventListener('click', () => {
    if (!s) return;
    s.follow = true;
    el.recenter.hidden = true;
    if (s.track.position) {
      const zoom = Math.max(map.getZoom(), 17);
      map.setView(followCenter(s.track.position, zoom), zoom, { animate: false });
    }
  });
  // Dragging the map by hand pauses following until the rider asks to recentre.
  map.on('dragstart', () => {
    if (!s) return;
    s.follow = false;
    el.recenter.hidden = false;
  });
  // Phones suspend GPS and release the wake lock while the page is in the background.
  document.addEventListener('visibilitychange', () => {
    if (!s || document.visibilityState !== 'visible') return;
    watch();
    keepAwake();
  });

  if (SIM) {
    const simulate = (lat, lon, accuracy = 5) => {
      const last = s?.track.position;
      onFix({ lat, lon, accuracy, heading: last ? bearing(last, [lat, lon]) : null });
      return s ? { ...s.track, snapped: undefined, target: s.track.target && { ...s.track.target } } : null;
    };
    map.on('click', (event) => {
      if (s) simulate(event.latlng.lat, event.latlng.lng);
    });
    window.__mbnSim = simulate;
  }

  return {
    start,
    stop,
    active: () => s != null,
    /** The navigation that was running when the page was last closed, or null. */
    pending: () => {
      const saved = lsGet(NAV_KEY, null);
      return saved && typeof saved.route?.geometry === 'string' && Array.isArray(saved.route.waypoints) ? saved : null;
    },
    forget: () => lsSet(NAV_KEY, null),
  };
}
