import './style.css';
import { initMap } from './map';
import { fetchBuildings } from './overpass';
import { parseBuildings, type Building } from './buildings';
import { bboxAreaKm2, bboxCenter, type BBox } from './geo';
import { IsoScene } from './scene';
import { computeRisk, RISK_DISCLAIMER } from './risk';

const MIN_ZOOM_FOR_3D = 15;
const MAX_AREA_KM2 = 1.2; // защита от слишком тяжёлых Overpass-запросов

const mapContainer = document.getElementById('map') as HTMLElement;
const sceneContainer = document.getElementById('scene-container') as HTMLElement;
const btnRender = document.getElementById('btn-render') as HTMLButtonElement;
const btnBack = document.getElementById('btn-back') as HTMLButtonElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const legend = document.getElementById('hud-legend') as HTMLElement;

const riskPanel = document.getElementById('risk-panel') as HTMLElement;
const riskClose = document.getElementById('risk-close') as HTMLButtonElement;
const riskTitle = document.getElementById('risk-title') as HTMLElement;
const riskFloor = document.getElementById('risk-floor') as HTMLInputElement;
const riskFloorHint = document.getElementById('risk-floor-hint') as HTMLElement;
const riskFacade = document.getElementById('risk-facade') as HTMLSelectElement;
const riskCalcBtn = document.getElementById('risk-calc') as HTMLButtonElement;
const riskStatus = document.getElementById('risk-status') as HTMLElement;
const riskResult = document.getElementById('risk-result') as HTMLElement;
const riskScoreEl = document.getElementById('risk-score') as HTMLElement;
const riskRowsEl = document.getElementById('risk-rows') as HTMLElement;
const riskDisclaimerTop = document.getElementById('risk-disclaimer-top') as HTMLElement;
const riskDisclaimerBottom = document.getElementById('risk-disclaimer-bottom') as HTMLElement;

riskDisclaimerTop.textContent = RISK_DISCLAIMER;
riskDisclaimerBottom.textContent = RISK_DISCLAIMER;

let currentBuildings: Building[] = [];
let selectedBuilding: Building | null = null;

const map = initMap(mapContainer);
let scene: IsoScene | null = null;

function setStatus(text: string) {
  statusText.textContent = text;
}

function currentBBox(): BBox {
  const b = map.getBounds();
  return {
    south: b.getSouth(),
    west: b.getWest(),
    north: b.getNorth(),
    east: b.getEast(),
  };
}

map.on('load', () => {
  setStatus('Наведите карту на нужный участок и нажмите «Построить 3D»');
});

map.on('move', () => {
  const zoom = map.getZoom();
  if (zoom < MIN_ZOOM_FOR_3D) {
    setStatus(`Приблизьте карту (сейчас zoom ${zoom.toFixed(1)}, нужно ≥ ${MIN_ZOOM_FOR_3D})`);
    btnRender.disabled = true;
  } else {
    const area = bboxAreaKm2(currentBBox());
    if (area > MAX_AREA_KM2) {
      setStatus(`Область великовата (~${area.toFixed(2)} км²) — приблизьте ещё`);
      btnRender.disabled = true;
    } else {
      setStatus(`Область ~${(area * 1e6).toFixed(0)} м² — готово к построению`);
      btnRender.disabled = false;
    }
  }
});

btnRender.addEventListener('click', async () => {
  const bbox = currentBBox();
  const area = bboxAreaKm2(bbox);
  if (area > MAX_AREA_KM2) {
    setStatus('Область слишком большая — приблизьте карту');
    return;
  }

  btnRender.disabled = true;
  setStatus('Запрашиваю здания у Overpass API…');

  try {
    const elements = await fetchBuildings(bbox);
    setStatus(`Получено объектов: ${elements.length}. Строю геометрию…`);

    const center = bboxCenter(bbox);
    const buildings = parseBuildings(elements, center);

    if (buildings.length === 0) {
      setStatus('В этой области зданий с тегом building не найдено');
      btnRender.disabled = false;
      return;
    }

    mapContainer.classList.add('hidden');
    sceneContainer.classList.remove('hidden');
    btnBack.classList.remove('hidden');
    legend.classList.remove('hidden');

    currentBuildings = buildings;

    if (!scene) {
      scene = new IsoScene(sceneContainer);
      scene.onSelect(handleBuildingSelect);
    }
    scene.render(buildings);

    const exact = buildings.filter((b) => b.heightSource === 'exact').length;
    const levels = buildings.filter((b) => b.heightSource === 'levels').length;
    const guess = buildings.filter((b) => b.heightSource === 'guess').length;
    setStatus(
      `Зданий: ${buildings.length} · height: ${exact} · по этажам: ${levels} · оценка: ${guess}. Тяните мышью — вращать, клик по зданию — оценка риска.`
    );
  } catch (err) {
    console.error(err);
    setStatus('Ошибка запроса к Overpass API — попробуйте ещё раз через пару секунд');
  } finally {
    btnRender.disabled = false;
  }
});

btnBack.addEventListener('click', () => {
  sceneContainer.classList.add('hidden');
  btnBack.classList.add('hidden');
  legend.classList.add('hidden');
  riskPanel.classList.add('hidden');
  mapContainer.classList.remove('hidden');
  map.resize();
});

function buildingLabel(b: Building): string {
  const addr = [b.tags['addr:street'], b.tags['addr:housenumber']].filter(Boolean).join(', ');
  if (addr) return addr;
  if (b.tags.name) return b.tags.name;
  return `Здание · ${b.tags.building !== 'yes' ? b.tags.building : 'тип не указан'}`;
}

function heightSourceLabel(source: Building['heightSource']): string {
  if (source === 'exact') return 'точная высота из OSM';
  if (source === 'levels') return 'по этажам из OSM';
  return 'нет данных в OSM, грубая оценка';
}

function handleBuildingSelect(building: Building) {
  selectedBuilding = building;
  riskTitle.textContent = buildingLabel(building);

  const floorsGuess = Math.max(1, Math.round(building.heightMeters / 3));
  riskFloor.value = String(floorsGuess);
  riskFloor.max = String(Math.max(40, floorsGuess));
  riskFloorHint.textContent = `Высота ${building.heightMeters.toFixed(0)} м → ~${floorsGuess} эт. (${heightSourceLabel(
    building.heightSource
  )}). Поправьте, если это не так.`;

  riskResult.classList.add('hidden');
  riskStatus.textContent = '';
  riskPanel.classList.remove('hidden');
}

riskClose.addEventListener('click', () => {
  riskPanel.classList.add('hidden');
});

riskCalcBtn.addEventListener('click', async () => {
  if (!selectedBuilding) return;
  const building = selectedBuilding;

  riskCalcBtn.disabled = true;
  riskResult.classList.add('hidden');

  try {
    const myFloor = Math.max(1, parseInt(riskFloor.value, 10) || 1);
    const facadeVal = parseInt(riskFacade.value, 10);
    const facadeAzimuth = facadeVal >= 0 ? facadeVal : null;

    const nearbyBuildings = currentBuildings
      .filter((b) => b.id !== building.id)
      .map((b) => ({ centroid: b.centroid, heightMeters: b.heightMeters }));

    const result = await computeRisk({
      home: building.centroid,
      houseHeightM: building.heightMeters,
      myFloor,
      facadeAzimuth,
      nearbyBuildings,
      onStatus: (text) => {
        riskStatus.textContent = text;
      },
    });

    riskScoreEl.className = `risk-score ${result.level}`;
    riskScoreEl.innerHTML = `${result.score}/100<span class="risk-score-label">${result.levelLabel} расчётный риск</span>`;
    riskRowsEl.innerHTML = result.rows
      .map((r) => `<div class="risk-row"><span>${r.label}</span><b>${r.value}</b></div>`)
      .join('');
    riskResult.classList.remove('hidden');
    riskStatus.textContent = '';
  } catch (err) {
    console.error(err);
    riskStatus.textContent = 'Ошибка расчёта (не отвечает Overpass или Open-Meteo) — попробуйте ещё раз';
  } finally {
    riskCalcBtn.disabled = false;
  }
});
