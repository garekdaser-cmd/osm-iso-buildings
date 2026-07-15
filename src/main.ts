import './style.css';
import { initMap } from './map';
import { fetchBuildings } from './overpass';
import { parseBuildings } from './buildings';
import { bboxAreaKm2, bboxCenter, type BBox } from './geo';
import { IsoScene } from './scene';

const MIN_ZOOM_FOR_3D = 15;
const MAX_AREA_KM2 = 1.2; // защита от слишком тяжёлых Overpass-запросов

const mapContainer = document.getElementById('map') as HTMLElement;
const sceneContainer = document.getElementById('scene-container') as HTMLElement;
const btnRender = document.getElementById('btn-render') as HTMLButtonElement;
const btnBack = document.getElementById('btn-back') as HTMLButtonElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const legend = document.getElementById('hud-legend') as HTMLElement;

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

    if (!scene) {
      scene = new IsoScene(sceneContainer);
    }
    scene.render(buildings);

    const exact = buildings.filter((b) => b.heightSource === 'exact').length;
    const levels = buildings.filter((b) => b.heightSource === 'levels').length;
    const guess = buildings.filter((b) => b.heightSource === 'guess').length;
    setStatus(
      `Зданий: ${buildings.length} · height: ${exact} · по этажам: ${levels} · оценка: ${guess}. Тяните мышью, чтобы вращать.`
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
  mapContainer.classList.remove('hidden');
  map.resize();
});
