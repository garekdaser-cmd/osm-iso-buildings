import type { LatLon } from './geo';
import { BORDER, angleDiff, bearingDeg, compassName, haversineDistance, nearestBorderPoint } from './border';
import { fetchElevations, interpolatePoints } from './elevation';
import { fetchHazards, type HazardElement } from './overpass';

export type RiskLevel = 'low' | 'mid' | 'high';

export interface RiskRow {
  label: string;
  value: string;
}

export interface HazardMarker {
  lat: number;
  lon: number;
  name: string;
  radiusM: number;
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  levelLabel: string;
  rows: RiskRow[];
  elevationProfile: number[];
  hazardMarkers: HazardMarker[];
  borderPoint: LatLon;
  disclaimer: string;
}

export interface NearbyBuilding {
  centroid: LatLon;
  heightMeters: number;
}

export interface RiskInput {
  home: LatLon;
  houseHeightM: number; // берём из уже известных данных OSM/оценки высоты здания
  myFloor: number; // указывает пользователь — какой этаж он занимает
  facadeAzimuth: number | null; // азимут стороны, куда смотрят окна; null = не указано
  nearbyBuildings: NearbyBuilding[]; // здания вокруг (уже загружены для отрисовки — доп. запрос не нужен)
  onStatus?: (text: string) => void;
}

const HAZARD_WEIGHTS: Array<{
  match: (tags: Record<string, string>) => boolean;
  weight: number;
  defaultName: string;
}> = [
  { match: (t) => !!t.military || t.landuse === 'military', weight: 25, defaultName: 'военный объект' },
  { match: (t) => t.power === 'plant', weight: 15, defaultName: 'электростанция' },
  { match: (t) => t.power === 'substation', weight: 10, defaultName: 'подстанция' },
  { match: (t) => t.man_made === 'works', weight: 12, defaultName: 'завод' },
  { match: (t) => /storage_tank|fuel/.test(t.man_made ?? ''), weight: 14, defaultName: 'нефтехранилище' },
  { match: (t) => t.landuse === 'industrial', weight: 8, defaultName: 'промзона' },
];

export const RISK_DISCLAIMER =
  'Это грубая эвристическая оценка на открытых данных (OSM, рельеф). НЕ является прогнозом. ' +
  'При сигнале тревоги — следуйте официальным инструкциям: отойдите от окон, укройтесь в помещении ' +
  'без остекления, в подвале, за капитальными стенами.';

export async function computeRisk(input: RiskInput): Promise<RiskResult> {
  const { home, houseHeightM, myFloor, facadeAzimuth, nearbyBuildings, onStatus } = input;

  // --- 1. направление и дистанция до границы ---
  onStatus?.('Ищу ближайшую точку границы…');
  const { point: borderPoint, distanceMeters } = nearestBorderPoint(home);
  const distKm = distanceMeters / 1000;
  const approachBearing = bearingDeg(borderPoint, home); // направление подлёта
  const bearingToBorder = (approachBearing + 180) % 360; // направление "к угрозе" от дома

  // --- 2. профиль рельефа между границей и домом ---
  onStatus?.('Загружаю профиль рельефа (Open-Meteo)…');
  const N = 60;
  const samples = interpolatePoints(borderPoint, home, N + 1);
  const elev = await fetchElevations(samples);
  const elevBorder = elev[0];
  const elevHome = elev[N];

  const houseH = houseHeightM;
  const targetAlt = elevHome + houseH;
  const launchAlt = elevBorder + 80; // условная высота подлёта БПЛА ~80 м AGL
  let masked = 0;
  for (let i = 1; i < N; i++) {
    const lineAlt = launchAlt + ((targetAlt - launchAlt) * i) / N;
    if (elev[i] > lineAlt + 15) masked++;
  }
  const maskFrac = masked / (N - 1);

  const tailCount = Math.max(1, Math.round(5 / (distKm / N)));
  const tail = elev.slice(Math.max(0, N - tailCount));
  const tailMean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const relElev = elevHome - tailMean;

  // --- 3. соседние здания как "экраны" (используем уже загруженный набор) ---
  let shieldScore = 0;
  let shieldCount = 0;
  for (const b of nearbyBuildings) {
    const d = haversineDistance(home, b.centroid);
    if (d < 10 || d > 220) continue;
    const brg = bearingDeg(home, b.centroid);
    if (angleDiff(brg, bearingToBorder) > 50) continue; // не со стороны угрозы
    if (b.heightMeters >= houseH - 3) {
      shieldCount++;
      shieldScore += Math.min(1, b.heightMeters / houseH) * (1 - d / 220);
    }
  }
  const shieldFactor = Math.max(0.45, 1 - Math.min(0.55, shieldScore * 0.18));

  // --- 4. объекты повышенного риска рядом ---
  onStatus?.('Ищу военные/промышленные объекты рядом (Overpass)…');
  let hazards: HazardElement[] = [];
  try {
    hazards = await fetchHazards(home, 5000);
  } catch {
    onStatus?.('Overpass недоступен — пропускаю поиск объектов рядом');
  }

  let hazardBonus = 0;
  let nearestHazard: { name: string; distanceM: number } | null = null;
  let nearestHazardDist = Infinity;
  const hazardMarkers: HazardMarker[] = [];

  for (const h of hazards) {
    const point: LatLon = { lat: h.lat, lon: h.lon };
    const d = haversineDistance(home, point);
    const rule = HAZARD_WEIGHTS.find((r) => r.match(h.tags));
    if (!rule) continue;
    const name = h.tags.name || rule.defaultName;
    const decay = Math.exp(-d / 1200);
    hazardBonus += rule.weight * decay;
    if (d < nearestHazardDist) {
      nearestHazardDist = d;
      nearestHazard = { name, distanceM: d };
    }
    hazardMarkers.push({ lat: h.lat, lon: h.lon, name, radiusM: Math.min(800, 200 + rule.weight * 20) });
  }
  hazardBonus = Math.min(30, hazardBonus);

  // --- 5. ориентация окон ---
  let facadeFactor = 1;
  let facadeNote = 'не указано';
  if (facadeAzimuth !== null && facadeAzimuth >= 0) {
    const diff = angleDiff(facadeAzimuth, bearingToBorder);
    if (diff < 40) {
      facadeFactor = 1.25;
      facadeNote = 'окна смотрят на угрозу (+25%)';
    } else if (diff < 80) {
      facadeFactor = 1.1;
      facadeNote = 'угол частично на угрозу (+10%)';
    } else {
      facadeFactor = 0.85;
      facadeNote = 'окна отвёрнуты от угрозы (−15%)';
    }
  }

  // --- 6. итоговая формула ---
  const baseByDist = 60 * Math.exp(-distKm / 70);
  const terrainFactor = 1 - 0.5 * maskFrac;
  const relElevFactor = 1 + Math.max(-0.15, Math.min(0.2, relElev / 100));
  const heightFactor = 1 + Math.min(0.25, (houseH - 15) / 100);
  const floorsTotal = Math.max(1, Math.round(houseH / 3));
  const floorFactor = myFloor >= floorsTotal - 1 ? 1.12 : myFloor <= 1 ? 0.9 : 1;

  let score =
    baseByDist * terrainFactor * relElevFactor * heightFactor * shieldFactor * facadeFactor * floorFactor +
    hazardBonus;
  score = Math.max(1, Math.min(99, Math.round(score)));

  const level: RiskLevel = score < 25 ? 'low' : score < 55 ? 'mid' : 'high';
  const levelLabel = level === 'low' ? 'Низкий' : level === 'mid' ? 'Умеренный' : 'Высокий';

  const rows: RiskRow[] = [
    { label: 'Расстояние до границы', value: `${distKm.toFixed(1)} км → база ${baseByDist.toFixed(0)}` },
    { label: 'Азимут на границу', value: `${Math.round(bearingToBorder)}° (${compassName(bearingToBorder)})` },
    { label: 'Маскирование рельефом', value: `${Math.round(maskFrac * 100)}% → ×${terrainFactor.toFixed(2)}` },
    {
      label: 'Отн. превышение рельефа',
      value: `${relElev >= 0 ? '+' : ''}${relElev.toFixed(0)} м → ×${relElevFactor.toFixed(2)}`,
    },
    { label: 'Высота здания', value: `${houseH.toFixed(0)} м → ×${heightFactor.toFixed(2)}` },
    { label: 'Соседние здания-экраны', value: `${shieldCount} шт → ×${shieldFactor.toFixed(2)}` },
    { label: 'Ориентация окон', value: `${facadeNote} → ×${facadeFactor.toFixed(2)}` },
    { label: 'Этаж', value: `${myFloor} из ${floorsTotal} → ×${floorFactor.toFixed(2)}` },
    {
      label: 'Ближайший объект риска',
      value: nearestHazard
        ? `${nearestHazard.name}, ${(nearestHazard.distanceM / 1000).toFixed(2)} км → +${hazardBonus.toFixed(0)}`
        : 'не найдено в OSM → +0',
    },
  ];

  onStatus?.('Готово.');

  return {
    score,
    level,
    levelLabel,
    rows,
    elevationProfile: elev,
    hazardMarkers,
    borderPoint,
    disclaimer: RISK_DISCLAIMER,
  };
}

export { BORDER };
