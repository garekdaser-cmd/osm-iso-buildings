import type { LatLon } from './geo';

// Огрублённая линия границы (Брянская > Курская > обл. южнее > Белгородская)
// Взята из пользовательского прототипа — приблизительная, для оценки порядка
// расстояния, не для точной геодезии.
export const BORDER: LatLon[] = [
  { lat: 52.35, lon: 31.6 },
  { lat: 52.1, lon: 31.9 },
  { lat: 52.05, lon: 32.4 },
  { lat: 52.25, lon: 33.1 },
  { lat: 52.35, lon: 33.8 },
  { lat: 52.2, lon: 34.1 },
  { lat: 51.95, lon: 34.15 },
  { lat: 51.7, lon: 34.05 },
  { lat: 51.55, lon: 34.25 },
  { lat: 51.35, lon: 34.2 },
  { lat: 51.25, lon: 34.55 },
  { lat: 51.2, lon: 35.1 },
  { lat: 51.05, lon: 35.35 },
  { lat: 50.95, lon: 35.45 },
  { lat: 50.75, lon: 35.45 },
  { lat: 50.6, lon: 35.4 },
  { lat: 50.45, lon: 35.5 },
  { lat: 50.35, lon: 35.75 },
  { lat: 50.3, lon: 36.1 },
  { lat: 50.32, lon: 36.35 },
  { lat: 50.28, lon: 36.65 },
  { lat: 50.2, lon: 36.95 },
  { lat: 50.05, lon: 37.3 },
  { lat: 49.95, lon: 37.6 },
  { lat: 49.9, lon: 37.95 },
  { lat: 49.95, lon: 38.2 },
  { lat: 49.8, lon: 38.55 },
  { lat: 49.6, lon: 38.95 },
  { lat: 49.35, lon: 39.2 },
  { lat: 49.05, lon: 39.55 },
  { lat: 48.85, lon: 39.8 },
  { lat: 48.6, lon: 39.9 },
  { lat: 48.3, lon: 39.85 },
  { lat: 47.95, lon: 39.6 },
  { lat: 47.6, lon: 38.9 },
  { lat: 47.25, lon: 38.55 },
];

const EARTH_RADIUS_M = 6371000;

export function haversineDistance(a: LatLon, b: LatLon): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(((b.lon - a.lon) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180);
  const x =
    Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) -
    Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(((b.lon - a.lon) * Math.PI) / 180);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function nearestBorderPoint(p: LatLon): { point: LatLon; distanceMeters: number } {
  // добавляем середины отрезков, чтобы не мазать по редким узлам ломаной
  const points: LatLon[] = [];
  for (let i = 0; i < BORDER.length; i++) {
    points.push(BORDER[i]);
    if (i < BORDER.length - 1) {
      points.push({
        lat: (BORDER[i].lat + BORDER[i + 1].lat) / 2,
        lon: (BORDER[i].lon + BORDER[i + 1].lon) / 2,
      });
    }
  }
  let best = points[0];
  let bestDist = Infinity;
  for (const q of points) {
    const d = haversineDistance(p, q);
    if (d < bestDist) {
      bestDist = d;
      best = q;
    }
  }
  return { point: best, distanceMeters: bestDist };
}

export function compassName(deg: number): string {
  const names = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
  return names[Math.round(deg / 45) % 8];
}
