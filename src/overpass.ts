import type { BBox, LatLon } from './geo';

// Публичные зеркала Overpass API — при отказе одного пробуем следующее
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export interface OverpassNode {
  lat: number;
  lon: number;
}

export interface OverpassElement {
  type: 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  geometry?: OverpassNode[]; // для way
  members?: Array<{
    type: string;
    role: string;
    geometry?: OverpassNode[];
  }>; // для relation
}

interface OverpassResponse {
  elements: OverpassElement[];
}

function buildQuery(bbox: BBox): string {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `[out:json][timeout:25];
(
  way["building"](${bboxStr});
  relation["building"]["type"="multipolygon"](${bboxStr});
);
out geom;`;
}

export async function fetchBuildings(bbox: BBox): Promise<OverpassElement[]> {
  const query = buildQuery(bbox);
  return runQuery(query);
}

export interface HazardElement {
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

function buildHazardQuery(center: LatLon, radiusM: number): string {
  const { lat, lon } = center;
  return `[out:json][timeout:25];
(
  nwr["military"](around:${radiusM},${lat},${lon});
  nwr["landuse"="military"](around:${radiusM},${lat},${lon});
  nwr["landuse"="industrial"](around:${Math.min(radiusM, 2500)},${lat},${lon});
  nwr["man_made"="works"](around:${Math.min(radiusM, 2500)},${lat},${lon});
  nwr["power"="substation"](around:${Math.min(radiusM, 2000)},${lat},${lon});
  nwr["power"="plant"](around:${Math.min(radiusM, 4000)},${lat},${lon});
  nwr["man_made"~"storage_tank|fuel"](around:${Math.min(radiusM, 2500)},${lat},${lon});
);
out center tags;`;
}

export async function fetchHazards(center: LatLon, radiusM = 5000): Promise<HazardElement[]> {
  const query = buildHazardQuery(center, radiusM);
  const elements = await runQuery(query);
  const hazards: HazardElement[] = [];
  for (const el of elements as unknown as Array<{
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
  }>) {
    const point = el.center ?? (el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : null);
    if (!point || !el.tags) continue;
    hazards.push({ lat: point.lat, lon: point.lon, tags: el.tags });
  }
  return hazards;
}

async function runQuery(query: string): Promise<OverpassElement[]> {
  let lastError: unknown = null;

  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) {
        throw new Error(`Overpass ответил ${res.status}`);
      }
      const data = (await res.json()) as OverpassResponse;
      return data.elements ?? [];
    } catch (err) {
      lastError = err;
      // пробуем следующее зеркало
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Overpass запрос не удался');
}
