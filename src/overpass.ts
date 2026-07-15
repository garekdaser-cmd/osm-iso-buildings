import type { BBox } from './geo';

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
