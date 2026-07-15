import type { OverpassElement, OverpassNode } from './overpass';
import { makeProjector, type LatLon, type LocalPoint } from './geo';

export type HeightSource = 'exact' | 'levels' | 'guess';

export interface Building {
  id: string;
  footprint: LocalPoint[]; // замкнутый контур в локальных метрах
  centroid: LatLon; // реальные координаты центра — нужны для доп. запросов (риск и т.п.)
  heightMeters: number;
  heightSource: HeightSource;
  tags: Record<string, string>;
}

const LEVEL_HEIGHT_M = 3;

// Дефолтные высоты по типу застройки, когда в OSM нет ни height, ни levels.
// Собраны эмпирически (typical practice), не претендуют на точность.
const DEFAULT_HEIGHTS: Record<string, number> = {
  house: 6,
  detached: 6,
  semidetached_house: 6,
  bungalow: 4,
  terrace: 7,
  apartments: 15,
  residential: 9,
  dormitory: 12,
  commercial: 11,
  retail: 6,
  office: 14,
  industrial: 8,
  warehouse: 8,
  church: 18,
  cathedral: 25,
  chapel: 8,
  school: 9,
  university: 12,
  hospital: 16,
  hotel: 18,
  garage: 3,
  garages: 3,
  shed: 3,
  civic: 10,
  public: 10,
  train_station: 10,
};

const FALLBACK_DEFAULT_HEIGHT = 9;

function parseHeightTag(raw: string): number | null {
  // допускаем "12", "12 m", "12.5", "~12", диапазон "10-12" (берём верхнюю границу)
  const cleaned = raw.trim().toLowerCase().replace(',', '.');
  const rangeMatch = cleaned.match(/(\d+(\.\d+)?)\s*-\s*(\d+(\.\d+)?)/);
  if (rangeMatch) {
    return parseFloat(rangeMatch[3]);
  }
  const match = cleaned.match(/(\d+(\.\d+)?)/);
  if (match) {
    return parseFloat(match[1]);
  }
  return null;
}

export function estimateHeight(tags: Record<string, string>): { meters: number; source: HeightSource } {
  if (tags.height) {
    const parsed = parseHeightTag(tags.height);
    if (parsed !== null && parsed > 0) {
      return { meters: parsed, source: 'exact' };
    }
  }

  if (tags['building:levels']) {
    const levels = parseFloat(tags['building:levels']);
    if (!Number.isNaN(levels) && levels > 0) {
      const roofLevels = tags['roof:levels'] ? parseFloat(tags['roof:levels']) || 0 : 0;
      return { meters: (levels + roofLevels) * LEVEL_HEIGHT_M, source: 'levels' };
    }
  }

  const buildingType = tags.building && tags.building !== 'yes' ? tags.building : null;
  const guessed = buildingType ? DEFAULT_HEIGHTS[buildingType] ?? FALLBACK_DEFAULT_HEIGHT : FALLBACK_DEFAULT_HEIGHT;
  return { meters: guessed, source: 'guess' };
}

function nodesToLatLon(nodes: OverpassNode[]): LatLon[] {
  return nodes.map((n) => ({ lat: n.lat, lon: n.lon }));
}

// Извлекаем контур (footprint) из way или relation(multipolygon).
// Для relation берём внешние (outer) кольца — упрощённо, без обработки holes.
function extractRings(el: OverpassElement): LatLon[][] {
  if (el.type === 'way' && el.geometry) {
    return [nodesToLatLon(el.geometry)];
  }
  if (el.type === 'relation' && el.members) {
    const outerRings = el.members
      .filter((m) => m.role === 'outer' && m.geometry && m.geometry.length > 2)
      .map((m) => nodesToLatLon(m.geometry!));
    return outerRings;
  }
  return [];
}

function ringCentroid(ring: LatLon[]): LatLon {
  // Простой средний центроид по узлам контура — для наших целей
  // (запрос к API по этой точке) точности среднего по вершинам достаточно,
  // настоящий geometric centroid тут избыточен.
  let latSum = 0;
  let lonSum = 0;
  const n = ring.length;
  for (const p of ring) {
    latSum += p.lat;
    lonSum += p.lon;
  }
  return { lat: latSum / n, lon: lonSum / n };
}

export function parseBuildings(elements: OverpassElement[], center: LatLon): Building[] {
  const project = makeProjector(center);
  const buildings: Building[] = [];

  for (const el of elements) {
    if (!el.tags?.building) continue;
    const rings = extractRings(el);
    const { meters, source } = estimateHeight(el.tags);

    for (const ring of rings) {
      if (ring.length < 3) continue;
      const footprint = ring.map(project);
      buildings.push({
        id: `${el.type}/${el.id}`,
        footprint,
        centroid: ringCentroid(ring),
        heightMeters: meters,
        heightSource: source,
        tags: el.tags,
      });
    }
  }

  return buildings;
}
