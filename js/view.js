// Panels sit on top of the full-screen map, so points are centred in the part of the map left in view.
const L = window.L;

/** Map centre that puts latlng in the middle of box ({ left, top, right, bottom }, map pixels) at zoom. */
export function centerFor(map, latlng, zoom, box) {
  if (box.bottom - box.top < 40 || box.right - box.left < 40) return L.latLng(latlng);
  const shift = L.point((box.left + box.right) / 2, (box.top + box.bottom) / 2).subtract(map.getSize().divideBy(2));
  return map.unproject(map.project(latlng, zoom).subtract(shift), zoom);
}
