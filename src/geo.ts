// Простая equirectangular-проекция относительно центра области.
// Для площадей в пределах нескольких км даёт приемлемую точность
// без искажений, характерных для глобальных проекций (Меркатор и т.п.)

const EARTH_RADIUS = 6378137; // метры

export interface LatLon {
  lat: number;
  lon: number;
}

export interface LocalPoint {
  x: number; // восток (+)
  z: number; // юг (+) / север (-) — так исходная сцена в three.js
             // ориентирована "севером от камеры"
}

export function makeProjector(center: LatLon) {
  const lat0Rad = (center.lat * Math.PI) / 180;
  const cosLat0 = Math.cos(lat0Rad);

  return function project({ lat, lon }: LatLon): LocalPoint {
    const x = ((lon - center.lon) * Math.PI * EARTH_RADIUS * cosLat0) / 180;
    const z = -((lat - center.lat) * Math.PI * EARTH_RADIUS) / 180;
    return { x, z };
  };
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function bboxCenter(bbox: BBox): LatLon {
  return {
    lat: (bbox.south + bbox.north) / 2,
    lon: (bbox.west + bbox.east) / 2,
  };
}

// Приблизительная площадь bbox в км² (для ограничения размера запроса)
export function bboxAreaKm2(bbox: BBox): number {
  const latSpanKm = ((bbox.north - bbox.south) * Math.PI * EARTH_RADIUS) / 180 / 1000;
  const lonSpanKm =
    ((bbox.east - bbox.west) * Math.PI * EARTH_RADIUS * Math.cos((bboxCenter(bbox).lat * Math.PI) / 180)) /
    180 /
    1000;
  return Math.abs(latSpanKm * lonSpanKm);
}
