import * as THREE from 'three';
import type { Building } from './buildings';

const COLORS: Record<Building['heightSource'], number> = {
  exact: 0x5eead4,
  levels: 0x7dd3fc,
  guess: 0x475569,
};

const WALL_COLOR = 0x1a3548;
const EDGE_COLOR = 0x0b1e2d;

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
  }

  private handleResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
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
      }
    }

    this.group = group;
    this.scene.add(group);

    // подгоняем масштаб камеры и дальность под размер сцены
    this.frustumSize = maxExtent * 2.3;
    this.radius = maxExtent * 3.5;
    this.azimuth = Math.PI / 4;
    this.zoomFactor = 1;
    this.handleResize();
    this.updateCameraPosition();

    this.startLoop();
  }

  private loopStarted = false;
  private startLoop() {
    if (this.loopStarted) return;
    this.loopStarted = true;
    const tick = () => {
      this.renderer.render(this.scene, this.camera);
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

function touchDistance(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function disposeGroup(group: THREE.Group) {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => m.dispose());
    }
  });
}
