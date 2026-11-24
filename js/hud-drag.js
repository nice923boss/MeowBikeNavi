// The navigation cards can be dragged up and down, so the rider picks which part of the map stays clear.
import { lsGet, lsSet } from './ui.js';

const KEY = 'mbn.hudY';
const GAP = 8; // kept between the cards and the buttons at the bottom

/**
 * cards: the element that moves; floor: the element it must stay above.
 * The place is saved as a share of the room it can move through (0 = top, 1 = lowest),
 * so it still fits after the screen turns or the cards change height.
 */
export function setupHudDrag(cards, floor, { onMoved } = {}) {
  let share = Math.min(Math.max(Number(lsGet(KEY, 0)) || 0, 0), 1);
  let offset = 0;
  let drag = null;

  const room = () => Math.max(floor.getBoundingClientRect().top - GAP - (cards.getBoundingClientRect().top - offset) - cards.offsetHeight, 0);
  const moveTo = (y) => {
    offset = y;
    cards.style.transform = y ? `translateY(${y}px)` : '';
  };
  let last = null;
  const apply = () => {
    if (drag) return;
    moveTo(Math.round(share * room()));
    // The clear part of the map changed (cards grew, shrank or moved), so let the map follow it.
    const { top, bottom } = cards.getBoundingClientRect();
    if (last && (top !== last.top || bottom !== last.bottom)) onMoved?.();
    last = { top, bottom };
  };

  cards.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    cards.setPointerCapture(event.pointerId);
    drag = { y: event.clientY, from: offset, room: room() };
    cards.classList.add('dragging');
  });
  cards.addEventListener('pointermove', (event) => {
    if (!drag) return;
    moveTo(Math.round(Math.min(Math.max(drag.from + event.clientY - drag.y, 0), drag.room)));
  });
  const end = () => {
    if (!drag) return;
    share = drag.room > 0 ? offset / drag.room : 0;
    drag = null;
    cards.classList.remove('dragging');
    lsSet(KEY, Number(share.toFixed(3)));
    const { top, bottom } = cards.getBoundingClientRect();
    last = { top, bottom };
    onMoved?.();
  };
  cards.addEventListener('pointerup', end);
  cards.addEventListener('pointercancel', end);

  new ResizeObserver(apply).observe(cards);
  window.addEventListener('resize', apply);
}
