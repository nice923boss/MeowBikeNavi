// Public OpenStreetMap-based services. All of them allow direct browser calls (CORS *).
export const ROUTER_URL = 'https://valhalla1.openstreetmap.de';
export const GEOCODER_URL = 'https://nominatim.openstreetmap.org';

export const DEFAULT_VIEW = { center: [25.0478, 121.5319], zoom: 13 };

// costing: Valhalla costing model. kmh: fallback speed for imported tracks without a duration.
export const VEHICLES = {
  bicycle: { label: '自行車', icon: '🚲', costing: 'bicycle', kmh: 15 },
  scooter: { label: '機車', icon: '🛵', costing: 'motor_scooter', kmh: 35 },
  car: { label: '汽車', icon: '🚗', costing: 'auto', kmh: 40 },
};

// Valhalla bicycle costing options, 0..1.
export const BIKE_PRESETS = {
  balanced: { label: '均衡', options: {} },
  quiet: { label: '避開車多的路', options: { use_roads: 0.1 } },
  flat: { label: '避開爬坡', options: { use_hills: 0.1 } },
  fast: { label: '最快抵達', options: { use_roads: 0.9, use_hills: 0.8 } },
};

export const TILE_LAYERS = {
  standard: {
    label: '標準',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 貢獻者',
    },
  },
  cycle: {
    label: '單車',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      subdomains: 'abc',
      attribution: '<a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a> | &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 貢獻者',
    },
  },
};
