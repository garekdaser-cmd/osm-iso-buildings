import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { BORDER } from './border';

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

// Брянск — по умолчанию, целевой регион использования приложения
const DEFAULT_CENTER: [number, number] = [34.3634, 53.2436];
const DEFAULT_ZOOM = 15;

export function initMap(container: HTMLElement): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: OSM_STYLE,
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  map.on('load', () => {
    const borderGeoJson: GeoJSON.Feature<GeoJSON.LineString> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: BORDER.map((p) => [p.lon, p.lat]),
      },
    };

    map.addSource('rf-ua-border', { type: 'geojson', data: borderGeoJson });

    // подсветка под линией — чтобы граница читалась поверх любой подложки
    map.addLayer({
      id: 'rf-ua-border-glow',
      type: 'line',
      source: 'rf-ua-border',
      paint: {
        'line-color': '#f87171',
        'line-width': 9,
        'line-opacity': 0.18,
        'line-blur': 3,
      },
    });

    map.addLayer({
      id: 'rf-ua-border-line',
      type: 'line',
      source: 'rf-ua-border',
      paint: {
        'line-color': '#f87171',
        'line-width': 2.5,
        'line-dasharray': [2, 2],
      },
    });
  });

  return map;
}
