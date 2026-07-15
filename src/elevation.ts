import type { LatLon } from './geo';

export async function fetchElevations(points: LatLon[]): Promise<number[]> {
  const lat = points.map((p) => p.lat.toFixed(5)).join(',');
  const lon = points.map((p) => p.lon.toFixed(5)).join(',');
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
  if (!res.ok) throw new Error('Elevation API недоступен');
  const data = (await res.json()) as { elevation: number[] };
  return data.elevation;
}

// Строит N равномерных точек по прямой между a и b (включая концы)
export function interpolatePoints(a: LatLon, b: LatLon, n: number): LatLon[] {
  const points: LatLon[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    points.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
  }
  return points;
}
