import type { Affine, Mesh, Vec3 } from './mesh';
import { transformMesh } from './mesh';

/** A design surface's local frame: U right, V up, N toward the viewer, all in part space. */
export interface Frame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Frame looking along -n with `up` as the screen's up: U = up × n. */
export function frameFromNormal(origin: Vec3, n: Vec3, up?: Vec3): Frame {
  n = normalize(n);
  let v = up ?? (Math.abs(n[1]) > 0.9 ? [0, 0, n[1] > 0 ? -1 : 1] : [0, 1, 0]);
  const u = normalize(cross(v, n));
  v = normalize(cross(n, u));
  return { origin, u, v, n };
}

/** Part space -> local (u, v, n) as an affine. */
export function worldToLocal(f: Frame): Affine {
  const o = f.origin;
  return [
    f.u[0], f.u[1], f.u[2], -dot(f.u, o),
    f.v[0], f.v[1], f.v[2], -dot(f.v, o),
    f.n[0], f.n[1], f.n[2], -dot(f.n, o),
  ];
}

export function localToWorld(f: Frame): Affine {
  const o = f.origin;
  return [
    f.u[0], f.v[0], f.n[0], o[0],
    f.u[1], f.v[1], f.n[1], o[1],
    f.u[2], f.v[2], f.n[2], o[2],
  ];
}

export function toLocalMesh(f: Frame, m: Mesh): Mesh {
  return transformMesh(m, worldToLocal(f));
}

export function toWorldMesh(f: Frame, m: Mesh): Mesh {
  return transformMesh(m, localToWorld(f));
}

export function localPoint(f: Frame, p: Vec3): Vec3 {
  const d: Vec3 = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]];
  return [dot(f.u, d), dot(f.v, d), dot(f.n, d)];
}

export function worldPoint(f: Frame, l: Vec3): Vec3 {
  return [
    f.origin[0] + f.u[0] * l[0] + f.v[0] * l[1] + f.n[0] * l[2],
    f.origin[1] + f.u[1] * l[0] + f.v[1] * l[1] + f.n[1] * l[2],
    f.origin[2] + f.u[2] * l[0] + f.v[2] * l[1] + f.n[2] * l[2],
  ];
}
