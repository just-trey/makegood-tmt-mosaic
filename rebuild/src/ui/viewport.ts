import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { designCorners, type Placement } from '../design/placement';
import type { Bounds, MultiPolygon, Pt } from '../design/poly';
import { localPoint, worldPoint, type Frame } from '../geometry/frame';
import type { Mesh, Vec3 } from '../geometry/mesh';

export interface ViewPiece {
  id: string;
  body: Mesh;
  inlays: { color: string; mesh: Mesh }[];
  /** Pieces that take no design are drawn dimmer. */
  dim?: boolean;
}

export interface OverlayDesign {
  id: string;
  active: boolean;
  placement: Placement;
  widthMm: number;
  heightMm: number;
  outlines: { color: string; mp: MultiPolygon }[];
  offSurface?: boolean;
}

type DragMode = 'move' | 'scale' | 'rotate';

function toGeometry(m: Mesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  g.computeVertexNormals();
  return g;
}

export class Viewport {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private partGroup = new THREE.Group();
  private overlayGroup = new THREE.Group();
  private frame: Frame | null = null;
  private bounds: Bounds | null = null;
  private heightAt: (u: number, v: number) => number | null = () => null;
  private designs: OverlayDesign[] = [];
  private handles: { id: string; kind: DragMode; world: THREE.Vector3; corner?: number }[] = [];
  private drag: { id: string; mode: DragMode; start: Placement; startUv: Pt; startAngle: number; startDist: number; h: number } | null = null;
  private surfaceKey = '';
  private raf = 0;
  onPlacement: ((id: string, p: Placement, final: boolean) => void) | null = null;
  onSelect: ((id: string) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene.background = new THREE.Color(0x070a13);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    this.camera.position.set(0, 0, 500);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.scene.add(new THREE.HemisphereLight(0xdde6ff, 0x1a1f33, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, 2, 3);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfd0ff, 0.5);
    fill.position.set(-2, -1, -2);
    this.scene.add(fill);
    this.scene.add(this.partGroup, this.overlayGroup);
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.pointerUp(e));
    window.addEventListener('resize', () => this.resize());
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }

  resize(): void {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setPieces(pieces: ViewPiece[], bodyColor: string): void {
    for (const c of this.partGroup.children) disposeObject(c);
    this.partGroup.clear();
    for (const p of pieces) {
      const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(bodyColor), flatShading: true, roughness: 0.75, metalness: 0.05, transparent: !!p.dim, opacity: p.dim ? 0.45 : 1 });
      this.partGroup.add(new THREE.Mesh(toGeometry(p.body), bodyMat));
      for (const inl of p.inlays) {
        const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(inl.color), flatShading: true, roughness: 0.7, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        this.partGroup.add(new THREE.Mesh(toGeometry(inl.mesh), mat));
      }
    }
  }

  /** Aim the camera at a design surface. Re-frames only when the surface changes. */
  setSurface(key: string, frame: Frame, bounds: Bounds, heightAt: (u: number, v: number) => number | null): void {
    this.frame = frame;
    this.bounds = bounds;
    this.heightAt = heightAt;
    if (key !== this.surfaceKey) {
      this.surfaceKey = key;
      this.frameCamera();
    }
    this.rebuildOverlay();
  }

  frameCamera(): void {
    if (!this.frame || !this.bounds) return;
    const f = this.frame, b = this.bounds;
    const cu = (b.minX + b.maxX) / 2, cv = (b.minY + b.maxY) / 2;
    const extent = Math.max(b.maxX - b.minX, (b.maxY - b.minY) * this.camera.aspect) || 100;
    const dist = (extent / 2 / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.15;
    const h = this.heightAt(cu, cv) ?? 0;
    const target = worldPoint(f, [cu, cv, h]);
    const eye = worldPoint(f, [cu, cv, h + dist]);
    this.camera.up.set(f.v[0], f.v[1], f.v[2]);
    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.controls.target.set(target[0], target[1], target[2]);
    this.camera.near = Math.max(0.5, dist / 100);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setDesigns(designs: OverlayDesign[]): void {
    this.designs = designs;
    this.rebuildOverlay();
  }

  private lift(u: number, v: number, extra = 0.4): THREE.Vector3 {
    const h = this.heightAt(u, v);
    const w = worldPoint(this.frame!, [u, v, (h ?? this.fallbackHeight()) + extra]);
    return new THREE.Vector3(w[0], w[1], w[2]);
  }

  private fallbackHeight(): number {
    return 0;
  }

  private rebuildOverlay(): void {
    for (const c of this.overlayGroup.children) disposeObject(c);
    this.overlayGroup.clear();
    this.handles = [];
    if (!this.frame) return;
    const size = this.bounds ? Math.max(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY) : 100;
    const handleR = Math.max(1.2, size * 0.012);
    for (const d of this.designs) {
      const corners = designCorners(d, d.placement);
      const color = d.offSurface ? 0xf0b429 : d.active ? 0x6d93ff : 0x7c88aa;
      // Frame, lifted onto the surface point by point so it follows a curve.
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        const n = 12;
        for (let k = 0; k < n; k++) {
          const t = k / n, t2 = (k + 1) / n;
          pts.push(this.lift(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), this.lift(a[0] + (b[0] - a[0]) * t2, a[1] + (b[1] - a[1]) * t2));
        }
      }
      const frameGeo = new THREE.BufferGeometry().setFromPoints(pts);
      this.overlayGroup.add(new THREE.LineSegments(frameGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: d.active ? 1 : 0.6 })));
      // Region outlines, per color, so the design is visible before the cut finishes.
      for (const o of d.outlines) {
        const seg: THREE.Vector3[] = [];
        for (const poly of o.mp)
          for (const ring of poly) {
            const step = Math.max(1, Math.floor(ring.length / 400));
            for (let i = 0; i < ring.length; i += step) {
              const a = ring[i], b = ring[(i + step) % ring.length];
              seg.push(this.lift(a[0], a[1], 0.25), this.lift(b[0], b[1], 0.25));
            }
          }
        if (seg.length === 0) continue;
        const g = new THREE.BufferGeometry().setFromPoints(seg);
        this.overlayGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(o.color), transparent: true, opacity: d.active ? 0.9 : 0.5 })));
      }
      if (!d.active) continue;
      const sphere = new THREE.SphereGeometry(handleR, 12, 8);
      corners.forEach((c, i) => {
        const m = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: 0x6d93ff }));
        const w = this.lift(c[0], c[1], 0.6);
        m.position.copy(w);
        this.overlayGroup.add(m);
        this.handles.push({ id: d.id, kind: 'scale', world: w, corner: i });
      });
      // Rotate handle: above the top edge's midpoint, in the design's own up direction.
      const top: Pt = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
      const cx = d.placement.x, cy = d.placement.y;
      const dx = top[0] - cx, dy = top[1] - cy;
      const len = Math.hypot(dx, dy) || 1;
      const off = Math.max(6, size * 0.06);
      const rp: Pt = [top[0] + (dx / len) * off, top[1] + (dy / len) * off];
      const rm = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: 0x5eead4 }));
      const rw = this.lift(rp[0], rp[1], 0.6);
      rm.position.copy(rw);
      this.overlayGroup.add(rm);
      const stem = new THREE.BufferGeometry().setFromPoints([this.lift(top[0], top[1], 0.5), rw]);
      this.overlayGroup.add(new THREE.Line(stem, new THREE.LineBasicMaterial({ color: 0x5eead4 })));
      this.handles.push({ id: d.id, kind: 'rotate', world: rw });
    }
  }

  private screen(v: THREE.Vector3): Pt {
    const p = v.clone().project(this.camera);
    return [((p.x + 1) / 2) * this.canvas.clientWidth, ((1 - p.y) / 2) * this.canvas.clientHeight];
  }

  /** Where the pointer's ray meets the plane through local height h on the design surface. */
  private hitUv(e: PointerEvent, h: number): Pt | null {
    if (!this.frame) return null;
    const rect = this.canvas.getBoundingClientRect();
    const nd = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
    const ray = new THREE.Raycaster();
    ray.setFromCamera(nd, this.camera);
    const f = this.frame;
    const n = new THREE.Vector3(f.n[0], f.n[1], f.n[2]);
    const o = worldPoint(f, [0, 0, h]);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(o[0], o[1], o[2]));
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    const l = localPoint(f, [hit.x, hit.y, hit.z] as Vec3);
    return [l[0], l[1]];
  }

  private handleAt(e: PointerEvent): { id: string; kind: DragMode } | null {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let best: { id: string; kind: DragMode } | null = null;
    let bd = 14;
    for (const h of this.handles) {
      const s = this.screen(h.world);
      const d = Math.hypot(s[0] - px, s[1] - py);
      if (d < bd) {
        bd = d;
        best = { id: h.id, kind: h.kind };
      }
    }
    return best;
  }

  private designAt(uv: Pt): OverlayDesign | null {
    // Active first, so an overlapping active design keeps the drag.
    const ordered = [...this.designs].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    for (const d of ordered) {
      const p = d.placement;
      const r = (-p.rotationDeg * Math.PI) / 180;
      const dx = uv[0] - p.x, dy = uv[1] - p.y;
      const lx = (Math.cos(r) * dx - Math.sin(r) * dy) / p.scale;
      const ly = (Math.sin(r) * dx + Math.cos(r) * dy) / p.scale;
      if (Math.abs(lx) <= d.widthMm / 2 && Math.abs(ly) <= d.heightMm / 2) return d;
    }
    return null;
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.frame) return;
    const handle = this.handleAt(e);
    const active = this.designs.find((d) => d.active);
    let target: OverlayDesign | null = null;
    let mode: DragMode = 'move';
    if (handle && active && handle.id === active.id) {
      target = active;
      mode = handle.kind;
    } else {
      const h0 = this.heightAt(active?.placement.x ?? 0, active?.placement.y ?? 0) ?? 0;
      const uv = this.hitUv(e, h0);
      if (!uv) return;
      const d = this.designAt(uv);
      if (!d) return;
      if (!d.active) {
        this.onSelect?.(d.id);
        return;
      }
      target = d;
    }
    const h = this.heightAt(target.placement.x, target.placement.y) ?? 0;
    const uv = this.hitUv(e, h);
    if (!uv) return;
    const p = target.placement;
    this.drag = { id: target.id, mode, start: { ...p }, startUv: uv, startAngle: Math.atan2(uv[1] - p.y, uv[0] - p.x), startDist: Math.hypot(uv[0] - p.x, uv[1] - p.y), h };
    this.controls.enabled = false;
    this.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.drag) {
      const handle = this.handleAt(e);
      if (handle) this.canvas.style.cursor = handle.kind === 'rotate' ? 'grab' : 'nwse-resize';
      else {
        const active = this.designs.find((d) => d.active);
        const uv = this.hitUv(e, this.heightAt(active?.placement.x ?? 0, active?.placement.y ?? 0) ?? 0);
        this.canvas.style.cursor = uv && this.designAt(uv) ? 'move' : '';
      }
      return;
    }
    const d = this.drag;
    const uv = this.hitUv(e, d.h);
    if (!uv) return;
    const p = { ...d.start };
    if (d.mode === 'move') {
      p.x = d.start.x + (uv[0] - d.startUv[0]);
      p.y = d.start.y + (uv[1] - d.startUv[1]);
    } else if (d.mode === 'scale') {
      const dist = Math.hypot(uv[0] - p.x, uv[1] - p.y);
      p.scale = Math.max(0.05, Math.min(20, (d.start.scale * dist) / Math.max(0.01, d.startDist)));
    } else {
      const a = Math.atan2(uv[1] - p.y, uv[0] - p.x);
      let deg = d.start.rotationDeg + ((a - d.startAngle) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      deg = ((((deg + 180) % 360) + 360) % 360) - 180;
      p.rotationDeg = deg;
    }
    this.onPlacement?.(d.id, p, false);
  }

  private pointerUp(e: PointerEvent): void {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    this.controls.enabled = true;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const current = this.designs.find((x) => x.id === d.id);
    if (current) this.onPlacement?.(d.id, current.placement, true);
  }
}

function disposeObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
