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

  // для вращения перетаскиванием мыши
  private isDragging = false;
  private lastPointer = { x: 0, y: 0 };
  private azimuth = Math.PI / 4; // текущий угол по горизонтали

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

  private bindInteraction() {
    const dom = this.renderer.domElement;
    dom.style.cursor = 'grab';

    dom.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      dom.style.cursor = 'grabbing';
    });
    window.addEventListener('pointerup', () => {
      this.isDragging = false;
      dom.style.cursor = 'grab';
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.isDragging || !this.group) return;
      const dx = e.clientX - this.lastPointer.x;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.azimuth += dx * 0.005;
      this.updateCameraPosition();
    });
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
    const frustum = this.frustumSize ?? 300;
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

    const group = new THREE.Group();
    let maxExtent = 10;

    for (const b of buildings) {
      const mesh = buildingMesh(b);
      if (mesh) {
        group.add(mesh);
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

function buildingMesh(b: Building): THREE.Group | null {
  if (b.footprint.length < 3) return null;

  const shape = new THREE.Shape();
  shape.moveTo(b.footprint[0].x, b.footprint[0].z);
  for (let i = 1; i < b.footprint.length; i++) {
    shape.lineTo(b.footprint[i].x, b.footprint[i].z);
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
  });
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: WALL_COLOR,
    roughness: 0.9,
    metalness: 0.0,
  });

  // ExtrudeGeometry: группа 0 — торцы (верх/низ, т.е. "крыша"), группа 1 — боковые стены
  const mesh = new THREE.Mesh(geometry, [roofMaterial, wallMaterial]);

  const edges = new THREE.EdgesGeometry(geometry, 25);
  const line = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.5 })
  );

  const group = new THREE.Group();
  group.add(mesh);
  group.add(line);
  return group;
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
