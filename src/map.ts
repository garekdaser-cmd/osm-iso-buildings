import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Стандартные растровые тайлы OSM — без ключа API.
// Для собственного продакшена уместно завести отдельный tile-сервер
// или использовать поставщика с явной лицензией на высокий трафик.
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm-tiles',
      type: 'raster',
      source: 'osm',
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

// Варшава — по умолчанию, чтобы карта сразу открывалась на населённом участке
const DEFAULT_CENTER: [number, number] = [21.0122, 52.2297];
const DEFAULT_ZOOM = 16;

export function initMap(container: HTMLElement): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: OSM_STYLE,
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  return map;
}
