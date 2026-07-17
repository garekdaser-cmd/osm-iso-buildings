import type { LatLon } from './geo';
import { angleDiff, bearingDeg, compassName, haversineDistance, sampleBorderLine } from './border';
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

// Один просчитанный луч "дом → точка на границе"
export interface RayResult {
  bearingDeg: number; // направление ОТ дома К угрозе
  distanceKm: number;
  score: number; // вклад именно этого направления в риск (без учёта hazardBonus)
  maskFrac: number;
  borderPoint: LatLon;
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  levelLabel: string;
  rows: RiskRow[];
  hazardMarkers: HazardMarker[];
  rays: RayResult[]; // отсортированы по убыванию риска, [0] — худший (используется как основной)
  raysChecked: number;
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
  rayCount?: number; // сколько направлений вдоль границы проверять (по умолчанию 18)
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
  'Это грубая эвристическая оценка на открытых данных (OSM, рельеф). Риск проверяется сразу по ' +
  'нескольким направлениям вдоль всей границы, а не только с ближайшей точки. НЕ является прогнозом. ' +
  'При сигнале тревоги — следуйте официальным инструкциям: отойдите от окон, укройтесь в помещении ' +
  'без остекления, в подвале, за капитальными стенами.';

// точек рельефа на один луч (меньше, чем было при одном луче — иначе при
// 18 лучах разом запрос к Open-Meteo станет непомерно длинным)
const ELEV_SAMPLES_PER_RAY = 13;

export async function computeRisk(input: RiskInput): Promise<RiskResult> {
  const { home, houseHeightM, myFloor, facadeAzimuth, nearbyBuildings, onStatus } = input;
  const rayCount = input.rayCount ?? 18;
  const houseH = houseHeightM;
  const floorsTotal = Math.max(1, Math.round(houseH / 3));
  const heightFactor = 1 + Math.min(0.25, (houseH - 15) / 100);
  const floorFactor = myFloor >= floorsTotal - 1 ? 1.12 : myFloor <= 1 ? 0.9 : 1;

  // --- 1. точки вдоль всей границы ---
  onStatus?.(`Строю сетку из ${rayCount} направлений вдоль границы…`);
  const borderPoints = sampleBorderLine(rayCount);

  // --- 2. рельеф по всем лучам одним пакетным запросом ---
  onStatus?.('Загружаю профиль рельефа по всем направлениям (Open-Meteo)…');
  const pointsPerRay = ELEV_SAMPLES_PER_RAY;
  const allSamples: LatLon[] = [];
  for (const bp of borderPoints) {
    allSamples.push(...interpolatePoints(bp, home, pointsPerRay));
  }
  let elevAll: number[] = [];
  try {
    elevAll = await fetchElevations(allSamples);
  } catch {
    onStatus?.('Open-Meteo недоступен — считаю без рельефа');
    elevAll = new Array(allSamples.length).fill(0);
  }

  // --- 3. объекты повышенного риска рядом (один раз, не зависит от направления) ---
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

  // --- 4. считаем каждый луч отдельно (рельеф, экранирование, ориентация окон) ---
  onStatus?.(`Считаю риск по ${rayCount} направлениям…`);
  const rays: RayResult[] = [];

  for (let i = 0; i < borderPoints.length; i++) {
    const borderPoint = borderPoints[i];
    const elev = elevAll.slice(i * pointsPerRay, (i + 1) * pointsPerRay);
    const N = pointsPerRay - 1;

    const distanceMeters = haversineDistance(home, borderPoint);
    const distKm = distanceMeters / 1000;
    const approachBearing = bearingDeg(borderPoint, home);
    const bearingToBorder = (approachBearing + 180) % 360;

    const elevBorder = elev[0] ?? 0;
    const elevHome = elev[N] ?? 0;
    const targetAlt = elevHome + houseH;
    const launchAlt = elevBorder + 80; // условная высота подлёта БПЛА ~80 м AGL
    let masked = 0;
    for (let s = 1; s < N; s++) {
      const lineAlt = launchAlt + ((targetAlt - launchAlt) * s) / N;
      if (elev[s] > lineAlt + 15) masked++;
    }
    const maskFrac = N > 1 ? masked / (N - 1) : 0;

    const tailCount = Math.max(1, Math.min(N, Math.round(5 / (distKm / N))));
    const tail = elev.slice(Math.max(0, N - tailCount));
    const tailMean = tail.reduce((a, b) => a + b, 0) / tail.length;
    const relElev = elevHome - tailMean;

    // экранирование соседними зданиями — конкретно со стороны ЭТОГО направления
    let shieldScore = 0;
    for (const b of nearbyBuildings) {
      const d = haversineDistance(home, b.centroid);
      if (d < 10 || d > 220) continue;
      const brg = bearingDeg(home, b.centroid);
      if (angleDiff(brg, bearingToBorder) > 50) continue;
      if (b.heightMeters >= houseH - 3) {
        shieldScore += Math.min(1, b.heightMeters / houseH) * (1 - d / 220);
      }
    }
    const shieldFactor = Math.max(0.45, 1 - Math.min(0.55, shieldScore * 0.18));

    // ориентация окон — тоже зависит от конкретного направления подлёта
    let facadeFactor = 1;
    if (facadeAzimuth !== null && facadeAzimuth >= 0) {
      const diff = angleDiff(facadeAzimuth, bearingToBorder);
      facadeFactor = diff < 40 ? 1.25 : diff < 80 ? 1.1 : 0.85;
    }

    const baseByDist = 60 * Math.exp(-distKm / 70);
    const terrainFactor = 1 - 0.5 * maskFrac;
    const relElevFactor = 1 + Math.max(-0.15, Math.min(0.2, relElev / 100));

    const rayScore = baseByDist * terrainFactor * relElevFactor * heightFactor * shieldFactor * facadeFactor * floorFactor;

    rays.push({ bearingDeg: bearingToBorder, distanceKm: distKm, score: rayScore, maskFrac, borderPoint });
  }

  // худшее направление определяет итоговую оценку — для безопасности важен
  // наихудший вероятный сценарий, а не усреднение по всем углам
  rays.sort((a, b) => b.score - a.score);
  const worst = rays[0];

  let score = worst.score + hazardBonus;
  score = Math.max(1, Math.min(99, Math.round(score)));

  const level: RiskLevel = score < 25 ? 'low' : score < 55 ? 'mid' : 'high';
  const levelLabel = level === 'low' ? 'Низкий' : level === 'mid' ? 'Умеренный' : 'Высокий';

  const shieldCountAtWorst = (() => {
    let c = 0;
    for (const b of nearbyBuildings) {
      const d = haversineDistance(home, b.centroid);
      if (d < 10 || d > 220) continue;
      const brg = bearingDeg(home, b.centroid);
      if (angleDiff(brg, worst.bearingDeg) > 50) continue;
      if (b.heightMeters >= houseH - 3) c++;
    }
    return c;
  })();

  const rows: RiskRow[] = [
    {
      label: 'Проверено направлений вдоль ГГ',
      value: `${rayCount} (худшее — ниже; средний скор по всем ${(
        rays.reduce((a, r) => a + r.score, 0) / rays.length
      ).toFixed(0)})`,
    },
    { label: 'Худшее направление — расстояние', value: `${worst.distanceKm.toFixed(1)} км` },
    { label: 'Худшее направление — азимут', value: `${Math.round(worst.bearingDeg)}° (${compassName(worst.bearingDeg)})` },
    { label: 'Маскирование рельефом (худшее направление)', value: `${Math.round(worst.maskFrac * 100)}%` },
    { label: 'Высота здания', value: `${houseH.toFixed(0)} м → ×${heightFactor.toFixed(2)}` },
    { label: 'Здания-экраны (с худшего направления)', value: `${shieldCountAtWorst} шт` },
    {
      label: 'Ориентация окон',
      value:
        facadeAzimuth !== null && facadeAzimuth >= 0
          ? `учтена относительно каждого направления`
          : 'не указано',
    },
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
    hazardMarkers,
    rays,
    raysChecked: rayCount,
    disclaimer: RISK_DISCLAIMER,
  };
}
