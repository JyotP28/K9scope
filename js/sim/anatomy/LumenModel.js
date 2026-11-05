// LumenModel: turns ANY lumen mesh + its centerline into something the
// simulator can drive a scope through. This is the seam that lets you swap the
// procedural anatomy for a mesh segmented from a real canine CT:
//
//   mesh        THREE.BufferGeometry of the mucosal surface (inside of the tube)
//   centerline  array of [x,y,z] points from entry (UES) to distal end, in cm
//   meta        { landmarks: {name: s_cm | [x,y,z]}, regions: [{name, from, to, insufflation}] }
//
// From that we derive (all at load time, no per-frame mesh queries):
//   - arc-length resampled centerline with rotation-minimising frames
//   - curvature vectors (used for scope "shaft stiffness")
//   - a radius table R[s][angle]: distance from centerline to the wall, used for
//     wall contact and red-out (fast, works for arbitrary meshes)
//   - per-vertex attributes aCenter / aInflate so the GPU can inflate/deflate
//     the organ around its centerline (insufflation & suction)

import * as THREE from 'three';

export const DS = 0.25;     // centerline sample spacing (cm)
export const ANG = 48;      // angular bins in the radius table

export class LumenModel {
  constructor(geometry, centerline, meta = {}) {
    this.geometry = geometry;
    this.meta = meta;
    this._resample(centerline);
    this._frames();
    this._landmarks(meta.landmarks || {});
    this._regions(meta.regions || []);
    this._vertexBinding();
  }

  // ---------------------------------------------------------- centerline ----
  _resample(pts) {
    const P = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + P[i].distanceTo(P[i - 1]));
    this.length = cum[cum.length - 1];
    const n = Math.max(2, Math.floor(this.length / DS) + 1);
    this.n = n;
    this.pts = new Float32Array(n * 3);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const s = i * DS;
      while (j < P.length - 2 && cum[j + 1] < s) j++;
      const seg = cum[j + 1] - cum[j] || 1;
      const t = Math.min(1, Math.max(0, (s - cum[j]) / seg));
      const v = new THREE.Vector3().lerpVectors(P[j], P[j + 1], t);
      this.pts.set([v.x, v.y, v.z], i * 3);
    }
  }

  _frames() {
    const n = this.n, P = this.pts;
    const T = new Float32Array(n * 3), N = new Float32Array(n * 3), B = new Float32Array(n * 3);
    const K = new Float32Array(n * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), t = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 2), i1 = Math.min(n - 1, i + 2);
      a.fromArray(P, i0 * 3); b.fromArray(P, i1 * 3);
      t.subVectors(b, a).normalize();
      T.set([t.x, t.y, t.z], i * 3);
    }
    // initial normal: world +Y projected onto the normal plane
    const t0 = new THREE.Vector3().fromArray(T, 0);
    let n0 = new THREE.Vector3(0, 1, 0).addScaledVector(t0, -t0.y);
    if (n0.lengthSq() < 1e-6) n0.set(1, 0, 0).addScaledVector(t0, -t0.x);
    n0.normalize();
    const nPrev = n0.clone(), tPrev = t0.clone(), q = new THREE.Quaternion(), tc = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      tc.fromArray(T, i * 3);
      if (i > 0) { q.setFromUnitVectors(tPrev, tc); nPrev.applyQuaternion(q); }
      nPrev.addScaledVector(tc, -nPrev.dot(tc)).normalize();
      const bb = new THREE.Vector3().crossVectors(tc, nPrev);
      N.set([nPrev.x, nPrev.y, nPrev.z], i * 3);
      B.set([bb.x, bb.y, bb.z], i * 3);
      tPrev.copy(tc);
    }
    // curvature vector dT/ds, smoothed over +-1.5 cm
    const raw = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 2), i1 = Math.min(n - 1, i + 2);
      a.fromArray(T, i0 * 3); b.fromArray(T, i1 * 3);
      const ds = (i1 - i0) * DS || 1;
      raw.set([(b.x - a.x) / ds, (b.y - a.y) / ds, (b.z - a.z) / ds], i * 3);
    }
    const w = Math.round(1.5 / DS);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sz = 0, sw = 0;
      for (let k = -w; k <= w; k++) {
        const ii = Math.min(n - 1, Math.max(0, i + k));
        const ww = w + 1 - Math.abs(k);
        sx += raw[ii * 3] * ww; sy += raw[ii * 3 + 1] * ww; sz += raw[ii * 3 + 2] * ww; sw += ww;
      }
      K.set([sx / sw, sy / sw, sz / sw], i * 3);
    }
    this.T = T; this.N = N; this.B = B; this.K = K;
  }

  _landmarks(lm) {
    this.landmarks = {};
    for (const [k, v] of Object.entries(lm)) {
      this.landmarks[k] = Array.isArray(v) ? this.nearestS(new THREE.Vector3(v[0], v[1], v[2])) : v;
    }
  }

  _regions(regions) {
    this.regions = regions.slice().sort((a, b) => a.from - b.from);
    // smooth per-sample insufflation weight
    const n = this.n;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = this.regionAt(i * DS);
      raw[i] = r ? (r.insufflation ?? 0) : 0;
    }
    const w = Math.round(1.5 / DS);
    this.inflW = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -w; k <= w; k++) { const ii = Math.min(n - 1, Math.max(0, i + k)); s += raw[ii]; c++; }
      this.inflW[i] = s / c;
    }
  }

  regionAt(s) {
    for (const r of this.regions) if (s >= r.from && s < r.to) return r;
    return this.regions[this.regions.length - 1] || null;
  }

  // ------------------------------------------------- vertex <-> centerline ----
  _vertexBinding() {
    const g = this.geometry;
    const pos = g.attributes.position;
    const nv = pos.count, n = this.n, P = this.pts, T = this.T, N = this.N, B = this.B;
    const aCenter = new Float32Array(nv * 3);
    const aInflate = new Float32Array(nv);
    const sum = new Float32Array(n * ANG), cnt = new Uint16Array(n * ANG);
    let hint = 0;
    const v = new THREE.Vector3();
    for (let k = 0; k < nv; k++) {
      v.fromBufferAttribute(pos, k);
      // local search from previous vertex's sample first (meshes are usually ring-ordered)
      let best = -1, bestD = Infinity;
      const tryRange = (lo, hi) => {
        for (let i = Math.max(0, lo); i <= Math.min(n - 1, hi); i++) {
          const dx = v.x - P[i * 3], dy = v.y - P[i * 3 + 1], dz = v.z - P[i * 3 + 2];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) { bestD = d; best = i; }
        }
      };
      tryRange(hint - 12, hint + 12);
      if (best === hint - 12 || best === hint + 12 || bestD > 64) { bestD = Infinity; tryRange(0, n - 1); }
      hint = best;
      const i = best;
      aCenter.set([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], k * 3);
      aInflate[k] = this.inflW[i];
      const rx = v.x - P[i * 3], ry = v.y - P[i * 3 + 1], rz = v.z - P[i * 3 + 2];
      const along = rx * T[i * 3] + ry * T[i * 3 + 1] + rz * T[i * 3 + 2];
      if (Math.abs(along) > DS * 2) continue; // end caps etc.
      const pn = rx * N[i * 3] + ry * N[i * 3 + 1] + rz * N[i * 3 + 2];
      const pb = rx * B[i * 3] + ry * B[i * 3 + 1] + rz * B[i * 3 + 2];
      const r = Math.hypot(pn, pb);
      let ang = Math.atan2(pb, pn); if (ang < 0) ang += Math.PI * 2;
      const j = Math.floor(ang / (Math.PI * 2) * ANG) % ANG;
      sum[i * ANG + j] += r; cnt[i * ANG + j]++;
    }
    g.setAttribute('aCenter', new THREE.BufferAttribute(aCenter, 3));
    g.setAttribute('aInflate', new THREE.BufferAttribute(aInflate, 1));

    // radius table with hole filling (angular, then along s)
    const R = new Float32Array(n * ANG).fill(-1);
    for (let idx = 0; idx < n * ANG; idx++) if (cnt[idx]) R[idx] = sum[idx] / cnt[idx];
    for (let i = 0; i < n; i++) {
      const row = i * ANG;
      let any = false; for (let j = 0; j < ANG; j++) if (R[row + j] > 0) { any = true; break; }
      if (!any) continue;
      for (let j = 0; j < ANG; j++) {
        if (R[row + j] > 0) continue;
        let l = 1, r = 1;
        while (R[row + ((j - l + ANG) % ANG)] <= 0) l++;
        while (R[row + ((j + r) % ANG)] <= 0) r++;
        const a = R[row + ((j - l + ANG) % ANG)], b = R[row + ((j + r) % ANG)];
        R[row + j] = a + (b - a) * (l / (l + r));
      }
    }
    for (let i = 0; i < n; i++) {
      if (R[i * ANG] > 0) continue;
      let lo = i - 1; while (lo >= 0 && R[lo * ANG] <= 0) lo--;
      let hi = i + 1; while (hi < n && R[hi * ANG] <= 0) hi++;
      for (let j = 0; j < ANG; j++) {
        const a = lo >= 0 ? R[lo * ANG + j] : (hi < n ? R[hi * ANG + j] : 1);
        const b = hi < n ? R[hi * ANG + j] : a;
        const t = (lo >= 0 && hi < n) ? (i - lo) / (hi - lo) : 0;
        R[i * ANG + j] = a + (b - a) * t;
      }
    }
    // light smoothing
    const S = new Float32Array(n * ANG);
    for (let i = 0; i < n; i++) for (let j = 0; j < ANG; j++) {
      let s = 0, c = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const ii = Math.min(n - 1, Math.max(0, i + di)), jj = (j + dj + ANG) % ANG;
        s += R[ii * ANG + jj]; c++;
      }
      S[i * ANG + j] = s / c;
    }
    this.R = S;
  }

  // -------------------------------------------------------------- queries ----
  _idx(s) { const f = Math.min(this.n - 1.0001, Math.max(0, s / DS)); const i = Math.floor(f); return [i, f - i]; }

  pointAt(s, out = new THREE.Vector3()) {
    const [i, t] = this._idx(s), P = this.pts;
    return out.set(
      P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * t,
      P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * t,
      P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t);
  }
  _lerpArr(A, s, out) {
    const [i, t] = this._idx(s);
    return out.set(
      A[i * 3] + (A[i * 3 + 3] - A[i * 3]) * t,
      A[i * 3 + 1] + (A[i * 3 + 4] - A[i * 3 + 1]) * t,
      A[i * 3 + 2] + (A[i * 3 + 5] - A[i * 3 + 2]) * t);
  }
  tangentAt(s, out = new THREE.Vector3()) { return this._lerpArr(this.T, s, out).normalize(); }
  normalAt(s, out = new THREE.Vector3()) { return this._lerpArr(this.N, s, out); }
  binormalAt(s, out = new THREE.Vector3()) { return this._lerpArr(this.B, s, out); }
  curvatureAt(s, out = new THREE.Vector3()) { return this._lerpArr(this.K, s, out); }

  inflateWeight(s) { const [i, t] = this._idx(s); return this.inflW[i] + (this.inflW[i + 1] - this.inflW[i]) * t; }
  inflateScale(s, inflate) { return 1 + (inflate - 1) * this.inflateWeight(s); }

  // wall distance from centerline at arc length s, polar angle ang (rad, in N/B frame)
  radius(s, ang, inflate = 1) {
    const [i, t] = this._idx(s);
    let a = ang / (Math.PI * 2) * ANG; a = ((a % ANG) + ANG) % ANG;
    const j0 = Math.floor(a), j1 = (j0 + 1) % ANG, u = a - j0;
    const R = this.R;
    const r0 = R[i * ANG + j0] * (1 - u) + R[i * ANG + j1] * u;
    const r1 = R[(i + 1) * ANG + j0] * (1 - u) + R[(i + 1) * ANG + j1] * u;
    return (r0 + (r1 - r0) * t) * this.inflateScale(s, inflate);
  }
  // radius in the direction of a world-space vector dir (perpendicular-ish to the centerline)
  radiusToward(s, dir, inflate = 1) {
    const n = this.normalAt(s, _v1), b = this.binormalAt(s, _v2);
    return this.radius(s, Math.atan2(dir.dot(b), dir.dot(n)), inflate);
  }

  nearestS(p, sHint = null, window = 10) {
    const n = this.n, P = this.pts;
    let lo = 0, hi = n - 1;
    if (sHint !== null) { lo = Math.max(0, Math.floor((sHint - window) / DS)); hi = Math.min(n - 1, Math.ceil((sHint + window) / DS)); }
    let best = lo, bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const dx = p.x - P[i * 3], dy = p.y - P[i * 3 + 1], dz = p.z - P[i * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    // refine along tangent
    const s0 = best * DS;
    const c = this.pointAt(s0, _v1), t = this.tangentAt(s0, _v2);
    const along = _v3.subVectors(p, c).dot(t);
    return Math.min(this.length, Math.max(0, s0 + Math.max(-DS, Math.min(DS, along))));
  }

  // Where is point p relative to the lumen? -> { s, r (dist from centerline), wall (wall radius there), gap = wall - r }
  locate(p, sHint = null, inflate = 1) {
    const s = this.nearestS(p, sHint);
    const c = this.pointAt(s, _v1);
    const rel = _v3.subVectors(p, c);
    const t = this.tangentAt(s, _v2);
    rel.addScaledVector(t, -rel.dot(t));
    const n = this.normalAt(s, _v4), b = this.binormalAt(s, _v5);
    const ang = Math.atan2(rel.dot(b), rel.dot(n));
    const r = rel.length();
    const wall = this.radius(s, ang, inflate);
    return { s, r, wall, gap: wall - r, ang };
  }
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
