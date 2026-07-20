import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Building } from './buildings';
import { centroidOfLocalPoints, type LocalPoint } from './geo';

const COLORS: Record<Building['heightSource'], number> = {
  exact: 0x5eead4,
  levels: 0x7dd3fc,
  guess: 0x475569,
};

const WALL_COLOR = 0x1a3548;
const EDGE_COLOR = 0x0b1e2d;

const LEVEL_COLOR: Record<'low' | 'mid' | 'high', number> = {
  low: 0x4ade80,
  mid: 0xfbbf24,
  high: 0xf87171,
};

export interface RiskRayInput {
  bearingDeg: number;
  score: number; // относительный вес луча (для толщины/яркости на визуализации)
  emphasized?: boolean; // попал в ручной сектор акцента — красим отдельным цветом
}

export interface RiskVisualizationInput {
  buildingCentroid: LocalPoint;
  buildingHeight: number;
  rays: RiskRayInput[]; // отсортированы по убыванию риска, [0] — худшее направление (основное)
  level: 'low' | 'mid' | 'high';
  hazards: Array<{ x: number; z: number; name: string; radiusM: number }>;
}

export class IsoScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private container: HTMLElement;
  private group: THREE.Group | null = null;

  private buildingsById = new Map<string, Building>();
  private meshesById = new Map<string, THREE.Mesh>();
  private selectedId: string | null = null;
  private onBuildingSelect: ((b: Building) => void) | null = null;
  private raycaster = new THREE.Raycaster();

  private labelRenderer: CSS2DRenderer;
  private labelObjects: CSS2DObject[] = [];
  private riskGroup: THREE.Group | null = null;
  private riskLabelObjects: CSS2DObject[] = [];
  private compassEl: HTMLDivElement;
  private compassArc!: SVGPathElement;
  private compassNeedleGroup!: SVGGElement;
  private compassHandleA!: SVGCircleElement;
  private compassHandleB!: SVGCircleElement;
  private lastNorthScreenAngle = 0;

  // сектор ручного акцента (в АБСОЛЮТНЫХ азимутах — не зависит от поворота камеры)
  private sectorEnabled = false;
  private sectorStartDeg = 200;
  private sectorEndDeg = 260;
  private sectorStrength = 0.25; // 0..0.5 → множитель ×1.0..×1.5
  private draggingHandle: 'a' | 'b' | null = null;
  private onSectorChange: (() => void) | null = null;

  private lastExtent = 100;

  // для вращения перетаскиванием мыши
  private isDragging = false;
  private lastPointer = { x: 0, y: 0 };
  private pointerDownPos = { x: 0, y: 0 };
  private azimuth = Math.PI / 4; // текущий угол по горизонтали

  // зум (колесо мыши / pinch)
  private zoomFactor = 1;
  private pinchStartDist: number | null = null;
  private pinchStartZoom = 1;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.top = '0';
    this.labelRenderer.domElement.style.left = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(this.labelRenderer.domElement);

    this.compassEl = document.createElement('div');
    this.compassEl.className = 'iso-compass';
    this.compassEl.innerHTML = `
      <svg class="cd-svg" viewBox="0 0 100 100" width="84" height="84">
        <circle class="cd-bg" cx="50" cy="50" r="40" />
        <path class="cd-arc" d="" />
        <g class="cd-needle-group">
          <polygon class="cd-needle" points="50,14 45,28 55,28" />
        </g>
        <circle class="cd-handle cd-handle-a" cx="50" cy="10" r="6" />
        <circle class="cd-handle cd-handle-b" cx="50" cy="10" r="6" />
      </svg>
      <span class="iso-compass-n">N</span>
      <label class="iso-sector-toggle">
        <input type="checkbox" class="iso-sector-checkbox" />
        ручной акцент
      </label>
      <div class="iso-sector-controls hidden">
        <input type="range" class="iso-sector-strength" min="0" max="50" value="25" />
        <span class="iso-sector-strength-label">+25%</span>
      </div>
    `;
    container.appendChild(this.compassEl);

    this.compassArc = this.compassEl.querySelector('.cd-arc')!;
    this.compassNeedleGroup = this.compassEl.querySelector('.cd-needle-group')!;
    this.compassHandleA = this.compassEl.querySelector('.cd-handle-a')!;
    this.compassHandleB = this.compassEl.querySelector('.cd-handle-b')!;
    this.bindCompassInteraction();

    this.scene = new THREE.Scene();

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);

    const ambient = new THREE.AmbientLight(0xffffff, 0.65);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(200, 400, 150);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x88bbdd, 0.25);
    fill.position.set(-200, 100, -150);
    this.scene.add(fill);

    this.bindInteraction();
    window.addEventListener('resize', () => this.handleResize());
    this.handleResize();
  }

  onSelect(cb: (b: Building) => void) {
    this.onBuildingSelect = cb;
  }

  private bindInteraction() {
    const dom = this.renderer.domElement;
    dom.style.cursor = 'grab';

    dom.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.pointerDownPos = { x: e.clientX, y: e.clientY };
      dom.style.cursor = 'grabbing';
    });
    window.addEventListener('pointerup', (e) => {
      this.isDragging = false;
      dom.style.cursor = 'grab';
      const movedDist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
      if (movedDist < 4) {
        this.handleClick(e.clientX, e.clientY);
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.isDragging || !this.group) return;
      const dx = e.clientX - this.lastPointer.x;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.azimuth += dx * 0.005;
      this.updateCameraPosition();
    });

    // зум колесом мыши
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
        this.zoomFactor = this.clampZoom(this.zoomFactor * factor);
        this.handleResize();
      },
      { passive: false }
    );

    // зум щипком (pinch) на тачскринах
    dom.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          this.pinchStartDist = touchDistance(e.touches);
          this.pinchStartZoom = this.zoomFactor;
          this.isDragging = false;
        }
      },
      { passive: true }
    );
    dom.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length === 2 && this.pinchStartDist) {
          e.preventDefault();
          const dist = touchDistance(e.touches);
          const ratio = this.pinchStartDist / dist;
          this.zoomFactor = this.clampZoom(this.pinchStartZoom * ratio);
          this.handleResize();
        }
      },
      { passive: false }
    );
    dom.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) this.pinchStartDist = null;
    });
  }

  private clampZoom(v: number): number {
    return Math.min(4, Math.max(0.2, v));
  }

  private handleClick(clientX: number, clientY: number) {
    if (!this.group) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const intersects = this.raycaster.intersectObjects(this.group.children, true);
    for (const hit of intersects) {
      const id = hit.object.userData.buildingId as string | undefined;
      if (id) {
        this.selectBuilding(id);
        return;
      }
    }
  }

  private selectBuilding(id: string) {
    const building = this.buildingsById.get(id);
    if (!building) return;

    // снимаем подсветку с предыдущего выбранного
    if (this.selectedId) {
      const prevMesh = this.meshesById.get(this.selectedId);
      if (prevMesh) {
        const mats = Array.isArray(prevMesh.material) ? prevMesh.material : [prevMesh.material];
        for (const m of mats) (m as THREE.MeshStandardMaterial).emissive?.setHex(0x000000);
      }
    }

    this.selectedId = id;
    const mesh = this.meshesById.get(id);
    if (mesh) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) (m as THREE.MeshStandardMaterial).emissive?.setHex(0xf2a65a);
    }

    this.onBuildingSelect?.(building);
  }

  private radius = 500;

  private updateCameraPosition() {
    const elevation = Math.atan(1 / Math.sqrt(2)); // классический изо-угол ~35.264°
    const r = this.radius;
    const x = r * Math.cos(elevation) * Math.cos(this.azimuth);
    const z = r * Math.cos(elevation) * Math.sin(this.azimuth);
    const y = r * Math.sin(elevation);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, 0, 0);
    this.updateCompass();
  }

  // угол на экране, под которым нужно повернуть стрелку "N", чтобы она
  // указывала на истинный север сцены при текущем повороте камеры.
  // Сектор акцента хранится в АБСОЛЮТНЫХ азимутах и на экране рисуется
  // со сдвигом на этот же угол — так дуга "едет" вместе со стрелкой при повороте сцены.
  private updateCompass() {
    const forward = new THREE.Vector3(0, 0, 0).sub(this.camera.position).normalize();
    const up = this.camera.up.clone();
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    const screenUp = new THREE.Vector3().crossVectors(right, forward).normalize();
    const north = new THREE.Vector3(0, 0, -1); // соглашение geo.ts: север = -Z
    const sx = north.dot(right);
    const sy = north.dot(screenUp);
    const angleDeg = (Math.atan2(sx, sy) * 180) / Math.PI;
    this.lastNorthScreenAngle = angleDeg;
    this.compassNeedleGroup.setAttribute('transform', `rotate(${angleDeg} 50 50)`);
    this.redrawSector();
  }

  private redrawSector() {
    const startScreen = this.sectorStartDeg + this.lastNorthScreenAngle;
    const endScreen = this.sectorEndDeg + this.lastNorthScreenAngle;

    const a = polarToCartesian(50, 50, 40, startScreen);
    const b = polarToCartesian(50, 50, 40, endScreen);
    this.compassHandleA.setAttribute('cx', String(a.x));
    this.compassHandleA.setAttribute('cy', String(a.y));
    this.compassHandleB.setAttribute('cx', String(b.x));
    this.compassHandleB.setAttribute('cy', String(b.y));

    if (this.sectorEnabled) {
      this.compassArc.setAttribute('d', describeArc(50, 50, 40, startScreen, endScreen));
      this.compassArc.setAttribute('opacity', '1');
    } else {
      this.compassArc.setAttribute('opacity', '0');
    }
  }

  private bindCompassInteraction() {
    const checkbox = this.compassEl.querySelector<HTMLInputElement>('.iso-sector-checkbox')!;
    const controls = this.compassEl.querySelector<HTMLElement>('.iso-sector-controls')!;
    const strengthInput = this.compassEl.querySelector<HTMLInputElement>('.iso-sector-strength')!;
    const strengthLabel = this.compassEl.querySelector<HTMLElement>('.iso-sector-strength-label')!;

    checkbox.addEventListener('change', () => {
      this.sectorEnabled = checkbox.checked;
      controls.classList.toggle('hidden', !this.sectorEnabled);
      this.redrawSector();
      this.onSectorChange?.();
    });

    strengthInput.addEventListener('input', () => {
      this.sectorStrength = Number(strengthInput.value) / 100;
      strengthLabel.textContent = `+${strengthInput.value}%`;
      this.onSectorChange?.();
    });

    const startDrag = (handle: 'a' | 'b') => (e: PointerEvent) => {
      e.stopPropagation();
      this.draggingHandle = handle;
      if (!this.sectorEnabled) {
        this.sectorEnabled = true;
        checkbox.checked = true;
        controls.classList.remove('hidden');
      }
    };
    this.compassHandleA.addEventListener('pointerdown', startDrag('a'));
    this.compassHandleB.addEventListener('pointerdown', startDrag('b'));

    window.addEventListener('pointermove', (e) => {
      if (!this.draggingHandle) return;
      const svg = this.compassEl.querySelector('svg')!;
      const rect = svg.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const screenAngle = (Math.atan2(dx, -dy) * 180) / Math.PI;
      const absBearing = ((screenAngle - this.lastNorthScreenAngle) % 360 + 360) % 360;
      if (this.draggingHandle === 'a') this.sectorStartDeg = absBearing;
      else this.sectorEndDeg = absBearing;
      this.redrawSector();
      this.onSectorChange?.();
    });
    window.addEventListener('pointerup', () => {
      this.draggingHandle = null;
    });
  }

  onSectorUpdate(cb: () => void) {
    this.onSectorChange = cb;
  }

  getEmphasisSector(): { startDeg: number; endDeg: number; strength: number } | null {
    if (!this.sectorEnabled) return null;
    return { startDeg: this.sectorStartDeg, endDeg: this.sectorEndDeg, strength: this.sectorStrength };
  }

  private handleResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    const aspect = w / h;
    const frustum = (this.frustumSize ?? 300) * this.zoomFactor;
    this.camera.left = (-frustum * aspect) / 2;
    this.camera.right = (frustum * aspect) / 2;
    this.camera.top = frustum / 2;
    this.camera.bottom = -frustum / 2;
    this.camera.updateProjectionMatrix();
  }

  private frustumSize: number | null = null;

  render(buildings: Building[]) {
    if (this.group) {
      this.scene.remove(this.group);
      disposeGroup(this.group);
    }
    this.clearLabels();
    this.clearRiskVisualization();

    this.buildingsById.clear();
    this.meshesById.clear();
    this.selectedId = null;

    const group = new THREE.Group();
    let maxExtent = 10;

    for (const b of buildings) {
      const built = buildingMesh(b);
      if (built) {
        group.add(built.group);
        this.buildingsById.set(b.id, b);
        this.meshesById.set(b.id, built.mesh);
        for (const p of b.footprint) {
          maxExtent = Math.max(maxExtent, Math.abs(p.x), Math.abs(p.z));
        }

        const houseNumber = b.tags['addr:housenumber'];
        if (houseNumber) {
          const c = centroidOfLocalPoints(b.footprint);
          const el = document.createElement('div');
          el.className = 'iso-house-label';
          el.textContent = houseNumber;
          const label = new CSS2DObject(el);
          label.position.set(c.x, b.heightMeters + 2, c.z);
          group.add(label);
          this.labelObjects.push(label);
        }
      }
    }

    this.group = group;
    this.scene.add(group);
    this.lastExtent = maxExtent;

    // подгоняем масштаб камеры и дальность под размер сцены
    this.frustumSize = maxExtent * 2.3;
    this.radius = maxExtent * 3.5;
    this.azimuth = Math.PI / 4;
    this.zoomFactor = 1;
    this.handleResize();
    this.updateCameraPosition();

    this.startLoop();
  }

  private clearLabels() {
    for (const lbl of this.labelObjects) {
      lbl.element.remove();
    }
    this.labelObjects = [];
  }

  clearRiskVisualization() {
    if (this.riskGroup) {
      this.scene.remove(this.riskGroup);
      disposeGroup(this.riskGroup);
      this.riskGroup = null;
    }
    for (const lbl of this.riskLabelObjects) {
      lbl.element.remove();
    }
    this.riskLabelObjects = [];
  }

  showRiskVisualization(input: RiskVisualizationInput) {
    this.clearRiskVisualization();
    const group = new THREE.Group();

    const rayLength = this.lastExtent * 1.4;
    const rayY = input.buildingHeight + 6;
    const start = new THREE.Vector3(input.buildingCentroid.x, rayY, input.buildingCentroid.z);
    const maxScore = input.rays.reduce((m, r) => Math.max(m, r.score), 1);

    input.rays.forEach((ray, idx) => {
      const isPrimary = idx === 0;
      const bearingRad = (ray.bearingDeg * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.sin(bearingRad), 0, -Math.cos(bearingRad));
      const end = start.clone().addScaledVector(dir, rayLength);
      const relIntensity = maxScore > 0 ? ray.score / maxScore : 0;
      const color = isPrimary ? LEVEL_COLOR[input.level] : ray.emphasized ? 0xc084fc : 0xf2a65a;

      const lineGeom = new THREE.BufferGeometry().setFromPoints([start, end]);
      const lineMat = new THREE.LineDashedMaterial({
        color,
        dashSize: isPrimary ? 6 : 4,
        gapSize: isPrimary ? 4 : 7,
        transparent: true,
        opacity: isPrimary ? 0.95 : ray.emphasized ? 0.5 + relIntensity * 0.35 : 0.2 + relIntensity * 0.35,
      });
      const line = new THREE.Line(lineGeom, lineMat);
      line.computeLineDistances();
      group.add(line);

      // стрелка-указатель у дальнего конца луча (откуда идёт угроза)
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(isPrimary ? 4 : 2.5, isPrimary ? 12 : 8, 8),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isPrimary ? 1 : 0.55 })
      );
      arrow.position.copy(end);
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
      arrow.quaternion.copy(quat);
      group.add(arrow);

      if (isPrimary) {
        const arrowLabelEl = document.createElement('div');
        arrowLabelEl.className = 'iso-ray-label';
        arrowLabelEl.textContent = 'худшее направление угрозы';
        const arrowLabel = new CSS2DObject(arrowLabelEl);
        arrowLabel.position.copy(end);
        group.add(arrowLabel);
        this.riskLabelObjects.push(arrowLabel);
      }
    });

    // --- маркеры опасных объектов рядом (если попадают в текущий масштаб сцены) ---
    for (const h of input.hazards) {
      const inner = 3 + Math.min(9, h.radiusM / 100);
      const ringGeom = new THREE.RingGeometry(inner, inner + 1.8, 24);
      ringGeom.rotateX(-Math.PI / 2);
      const ring = new THREE.Mesh(
        ringGeom,
        new THREE.MeshBasicMaterial({ color: 0xf87171, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
      );
      ring.position.set(h.x, 0.5, h.z);
      group.add(ring);

      const labelEl = document.createElement('div');
      labelEl.className = 'iso-hazard-label';
      labelEl.textContent = h.name;
      const label = new CSS2DObject(labelEl);
      label.position.set(h.x, 3, h.z);
      group.add(label);
      this.riskLabelObjects.push(label);
    }

    this.riskGroup = group;
    this.scene.add(group);
  }

  private loopStarted = false;
  private startLoop() {
    if (this.loopStarted) return;
    this.loopStarted = true;
    const tick = () => {
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
      requestAnimationFrame(tick);
    };
    tick();
  }
}

function buildingMesh(b: Building): { group: THREE.Group; mesh: THREE.Mesh } | null {
  if (b.footprint.length < 3) return null;

  const shape = new THREE.Shape();
  // rotateX(-90°) ниже переводит локальный Y формы в мировой Z с инверсией знака
  // (иначе вся сцена зеркалится по оси север-юг) — поэтому здесь заранее
  // подаём -z, компенсируя эту инверсию.
  shape.moveTo(b.footprint[0].x, -b.footprint[0].z);
  for (let i = 1; i < b.footprint.length; i++) {
    shape.lineTo(b.footprint[i].x, -b.footprint[i].z);
  }
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: b.heightMeters,
    bevelEnabled: false,
    curveSegments: 4,
  });
  // ExtrudeGeometry тянет вдоль локального Z; разворачиваем так,
  // чтобы экструзия шла вверх по мировой Y, а контур лёг в плоскость XZ.
  geometry.rotateX(-Math.PI / 2);

  const roofMaterial = new THREE.MeshStandardMaterial({
    color: COLORS[b.heightSource],
    roughness: 0.7,
    metalness: 0.05,
    side: THREE.DoubleSide, // порядок обхода колец в OSM не гарантирован — подстраховка от невидимых граней
  });
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: WALL_COLOR,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  // ExtrudeGeometry: группа 0 — торцы (верх/низ, т.е. "крыша"), группа 1 — боковые стены
  const mesh = new THREE.Mesh(geometry, [roofMaterial, wallMaterial]);
  mesh.userData.buildingId = b.id;

  const edges = new THREE.EdgesGeometry(geometry, 25);
  const line = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.5 })
  );

  const group = new THREE.Group();
  group.add(mesh);
  group.add(line);
  return { group, mesh };
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startAngleDeg: number, endAngleDeg: number): string {
  const start = polarToCartesian(cx, cy, r, endAngleDeg);
  const end = polarToCartesian(cx, cy, r, startAngleDeg);
  let sweep = endAngleDeg - startAngleDeg;
  sweep = ((sweep % 360) + 360) % 360;
  const largeArcFlag = sweep <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

function touchDistance(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function disposeGroup(group: THREE.Group) {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
      obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => m.dispose());
    }
  });
}
