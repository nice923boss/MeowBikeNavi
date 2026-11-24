// Map markers. Leaflet is loaded as a classic script, so `L` is a global.
const L = window.L;

const CAT_HEAD = '<svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">'
  + '<path d="M5 4l6 6h10l6-6v14a11 11 0 0 1-22 0z" fill="#1f1f24"/>'
  + '<ellipse cx="12" cy="17" rx="2.2" ry="3" fill="#c8e04a"/>'
  + '<ellipse cx="20" cy="17" rx="2.2" ry="3" fill="#c8e04a"/>'
  + '<path d="M14.8 21h2.4L16 22.6z" fill="#f08a3c"/></svg>';

const ARROW_UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 13h-5v7H9v-7H4z"/></svg>';

/** kind: 'start' (cat), 'via' (numbered), 'end' (fish). The pin tip sits on the coordinate. */
export function pinIcon(kind, n) {
  const inner = kind === 'start' ? CAT_HEAD : `<span>${kind === 'end' ? '🐟' : n}</span>`;
  return L.divIcon({
    className: '',
    html: `<div class="pin pin-${kind}">${inner}</div>`,
    iconSize: [34, 41],
    iconAnchor: [17, 41],
    popupAnchor: [0, -38],
  });
}

/** Rider position: dot, heading cone, and the arrow that points back to the route. */
export function userIcon() {
  return L.divIcon({
    className: '',
    html: `<div class="user"><div class="user-cone" hidden></div><div class="user-back" hidden>${ARROW_UP}</div><div class="user-dot"></div></div>`,
    iconSize: [96, 96],
    iconAnchor: [48, 48],
  });
}
