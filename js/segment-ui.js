// Planner pieces for route segments: the row between two points and how a segment is drawn.
import { formatDistance, formatDuration } from './geo.js';
import { isDetour } from './segments.js';
import { h } from './ui.js';

const LINE = '#f08a3c';
const LOCKED_LINE = '#b5541c';

/** Leaflet polyline options for a segment of the chosen line. */
export function segmentStyle(segment) {
  return {
    color: segment?.locked ? LOCKED_LINE : LINE,
    weight: 6,
    interactive: false,
    lineJoin: 'round',
    ...(segment?.walk ? { dashArray: '1 10', lineCap: 'round' } : {}),
  };
}

/** The row between two point rows: distance, lock and (bicycles only) walk-the-bike switches. */
export function segmentRow(segment, { from, to, bike, onLock, onWalk }) {
  const info = segment.coords ? `${formatDistance(segment.distance_m)} · ${formatDuration(segment.duration_s)}` : '規劃中…';
  const toggle = (on, label, title, onclick, disabled) => h('button', {
    type: 'button', class: on ? 'on' : null, 'aria-pressed': String(on), title, onclick, disabled,
  }, label);
  return h('div', { class: segment.locked ? 'seg locked' : 'seg' },
    h('span', { class: 'info' }, `↓ ${segment.walk ? '牽車 ' : ''}${info}`),
    bike && toggle(segment.walk, '🚶 牽車', '這段改用步行規劃，可走單車不能騎的路', onWalk, false),
    toggle(segment.locked, segment.locked ? '🔒 已固定' : '🔓 固定', '加減中途點時，這段路線保持不動', onLock, !segment.coords),
    bike && isDetour(segment, from, to) && h('small', { class: 'warn' },
      '繞路偏多：可能有路段沒開放單車。可在缺口兩端加中途點，把中間這段設為牽車'),
  );
}
