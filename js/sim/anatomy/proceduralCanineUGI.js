// Procedurally generated canine upper GI tract (medium dog, ~20 kg), units = cm.
//   upper esophageal sphincter -> esophagus (~28 cm) -> LES/cardia ->
//   stomach (fundus, body with rugal folds, antrum) -> tight pylorus ->
//   cranial duodenum -> cranial duodenal flexure -> descending duodenum.
//
// Output is plain data (geometry + centerline + meta) - the same shape a mesh
// loaded from glTF + JSON sidecar has - so the sim treats both identically.
//
// Axes: +X = animal's left, +Y = dorsal, -Z = caudal.

import * as THREE from 'three';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// cheap smooth 3D value noise
function makeNoise(rand) {
  const perm = new Uint8Array(512);
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const val = new Float32Array(256).map(() => rand() * 2 - 1);
  const fade = (t) => t * t * (3 - 2 * t);
  const h = (x, y, z) => val[perm[perm[perm[x & 255] + (y & 255)] + (z & 255)]];
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(h(xi, yi, zi), h(xi + 1, yi, zi), xf), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), xf), yf),
      l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), xf), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), xf), yf), zf);
  };
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// piecewise smooth interpolation through [s, value] keys
function keyed(keys) {
  return (s) => {
    if (s <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [s0, v0] = keys[i], [s1, v1] = keys[i + 1];
      if (s <= s1) { const t = smooth(s0, s1, s); return v0 + (v1 - v0) * t; }
    }
    return keys[keys.length - 1][1];
  };
}

export function generateCanineUGI(seed = 1) {
  const rand = mulberry32(seed * 9973 + 17);
  const noise = makeNoise(rand);
  const jit = (a) => (rand() * 2 - 1) * a;
  const size = 0.92 + rand() * 0.16; // patient size variation

  // ---- centerline control points (cm) ----
  const ctrl = [
    [0, 0, 0],                                   // UES
    [jit(0.3), -0.4, -7],                        // cervical
    [0.3 + jit(0.4), -1.0, -14],                 // thoracic inlet
    [0.9 + jit(0.4), -0.6 + jit(0.3), -21],      // heart base
    [1.4, -1.2, -26.5],                          // LES
    [2.2, -2.6, -29.2],                          // cardia
    [4.6 + jit(0.5), -5.6, -31.5],               // body (left, ventral)
    [3.0 + jit(0.6), -10.2, -33.5 + jit(0.6)],   // body, greater curvature region
    [-1.5 + jit(0.5), -12.0, -33.0],             // ventral body -> angle
    [-6.0 + jit(0.5), -10.0, -30.8],             // antrum
    [-8.4, -6.8, -28.8],                         // pyloric antrum
    [-9.2, -4.9, -27.6],                         // pylorus
    [-10.6, -3.6, -27.0],                        // cranial duodenum
    [-12.0, -3.0, -28.2],                        // cranial duodenal flexure
    [-12.4, -3.1, -31.5],                        // descending duodenum
    [-12.2 + jit(0.4), -3.6, -36.5],
    [-11.8 + jit(0.4), -4.0, -42],
  ].map((p) => new THREE.Vector3(p[0] * size, p[1] * size, p[2] * size));

  const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
  const L = curve.getLength();
  const DS = 0.25;
  const n = Math.floor(L / DS) + 1;
  const pts = curve.getSpacedPoints(n - 1);

  // arc length of each control point
  const sOf = (k) => {
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = p.distanceToSquared(ctrl[k]); if (d < bd) { bd = d; best = i; } });
    return best * DS;
  };
  const sLES = sOf(4), sCardia = sOf(5), sPyl = sOf(11), sFlex = sOf(13), sEnd = L;

  // ---- radius profile ----
  const R = keyed([
    [0, 0.85], [1.5, 1.15], [sLES - 1.5, 1.15],
    [sLES, 0.8], [sCardia - 0.8, 0.95],
    [sCardia + 1.2, 2.4], [sCardia + 5, 4.6], [sCardia + 11, 5.0],
    [sPyl - 9, 4.0], [sPyl - 5, 2.9], [sPyl - 1.6, 1.5], [sPyl - 0.4, 0.62],
    [sPyl + 0.4, 0.62], [sPyl + 1.4, 1.0], [sEnd, 1.0],
  ].map(([s, r]) => [s, r * size]));
  const stomachW = (s) => smooth(sCardia - 0.5, sCardia + 2.5, s) * (1 - smooth(sPyl - 2.5, sPyl - 0.2, s));
  const fundusW = (s) => smooth(sCardia, sCardia + 2.5, s) * (1 - smooth(sCardia + 4, sCardia + 9, s));

  // frames (parallel transport) for building the tube
  const T = [], N = [], B = [], K = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(n - 1, i + 2)];
    T.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  let nv = new THREE.Vector3(0, 1, 0).addScaledVector(T[0], -T[0].y).normalize();
  for (let i = 0; i < n; i++) {
    if (i > 0) nv.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(T[i - 1], T[i]));
    nv.addScaledVector(T[i], -nv.dot(T[i])).normalize();
    N.push(nv.clone()); B.push(new THREE.Vector3().crossVectors(T[i], nv));
  }
  for (let i = 0; i < n; i++) {
    const a = T[Math.max(0, i - 6)], b = T[Math.min(n - 1, i + 6)];
    K.push(new THREE.Vector3().subVectors(b, a)); // direction toward curvature centre
  }

  // ---- surface ----
  const SEG = 96;
  const ringPh = rand() * 10, rugPh = rand() * 10;
  const positions = new Float32Array(n * SEG * 3);
  const colors = new Float32Array(n * SEG * 3);
  const uvs = new Float32Array(n * SEG * 2);
  const folds = new Float32Array(n * SEG);

  const cEso = new THREE.Color(0.93, 0.66, 0.62), cSto = new THREE.Color(0.86, 0.36, 0.33);
  const cPyl = new THREE.Color(0.90, 0.48, 0.42), cDuo = new THREE.Color(0.92, 0.62, 0.46);
  const col = new THREE.Color();
  const dir = new THREE.Vector3(), kd = new THREE.Vector3(), p = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    const s = i * DS;
    const r0 = R(s);
    const sw = stomachW(s), fw = fundusW(s);
    kd.copy(K[i]); const kl = kd.length(); if (kl > 1e-6) kd.multiplyScalar(1 / kl); else kd.copy(N[i]);
    const isEso = s < sCardia - 0.5, isDuo = s > sPyl + 0.6;
    const pylW = Math.exp(-((s - sPyl) ** 2) / 1.2);
    for (let j = 0; j < SEG; j++) {
      const th = (j / SEG) * Math.PI * 2;
      dir.copy(N[i]).multiplyScalar(Math.cos(th)).addScaledVector(B[i], Math.sin(th));
      const towardInner = dir.dot(kd); // +1 lesser curvature (inside of J), -1 greater curvature
      let r = r0;
      // lesser curvature flattening & fundus bulge
      r *= 1 - 0.38 * sw * Math.pow(Math.max(0, towardInner), 1.4);
      r += 1.6 * size * fw * Math.pow(Math.max(0, -towardInner * 0.8 + dir.y * 0.6), 2);
      // organic low-frequency variation
      p.copy(pts[i]).addScaledVector(dir, r0);
      r *= 1 + 0.06 * noise(p.x * 0.35, p.y * 0.35, p.z * 0.35);

      // folds (inward displacement, cm)
      let fold = 0;
      if (isEso) {
        // shallow longitudinal folds of the canine esophagus
        fold = 0.07 * Math.max(0, Math.sin(th * 9 + 0.5 * Math.sin(s * 0.3 + ringPh)));
      }
      if (sw > 0.01) {
        // gastric rugae: tortuous longitudinal ridges, strongest along greater curvature
        const wav = th * 12 + 1.6 * Math.sin(s * 0.33 + th * 2 + rugPh) + 1.4 * noise(p.x * 0.5, p.y * 0.5, p.z * 0.5);
        const ridge = Math.pow(Math.max(0, Math.sin(wav)), 3);
        const gc = 0.45 + 0.55 * Math.max(0, -towardInner);
        fold += sw * 0.55 * size * gc * ridge;
      }
      if (pylW > 0.02) fold += pylW * 0.16 * Math.pow(Math.max(0, Math.sin(th * 8 + 0.7)), 2); // pyloric folds converge
      if (isDuo) fold += 0.03 * Math.max(0, noise(p.x * 3, p.y * 3, p.z * 3));
      r -= fold;
      folds[i * SEG + j] = fold;

      const v = p.copy(pts[i]).addScaledVector(dir, Math.max(0.3, r));
      positions.set([v.x, v.y, v.z], (i * SEG + j) * 3);

      // colour by region (+ mottling)
      if (s < sCardia - 1) col.copy(cEso);
      else if (s < sCardia + 1.5) col.copy(cEso).lerp(cSto, smooth(sCardia - 1, sCardia + 1.5, s));
      else if (s < sPyl - 2) col.copy(cSto);
      else if (s < sPyl + 1) col.copy(cSto).lerp(cPyl, smooth(sPyl - 2, sPyl, s));
      else col.copy(cPyl).lerp(cDuo, smooth(sPyl, sPyl + 2, s));
      const mott = 0.08 * noise(v.x * 1.3, v.y * 1.3, v.z * 1.3) - 0.10 * (fold > 0.05 && sw > 0.2 ? 0 : 0);
      // fold crests slightly paler, valleys deeper red
      const crest = sw > 0.1 ? 0.10 * (fold / (0.55 * size)) : 0;
      colors.set([col.r * (1 + mott + crest * 0.3), col.g * (1 + mott + crest), col.b * (1 + mott + crest)], (i * SEG + j) * 3);

      uvs.set([s / 2.0, (j / SEG) * Math.max(1, Math.round(2 * Math.PI * r0 / 2))], (i * SEG + j) * 2);
    }
  }

  const index = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * SEG + j, b = i * SEG + ((j + 1) % SEG), c = (i + 1) * SEG + j, d = (i + 1) * SEG + ((j + 1) % SEG);
      // winding so normals face INTO the lumen (toward the camera)
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('fold', new THREE.BufferAttribute(folds, 1));
  geo.setIndex(index);
  geo.computeVertexNormals();

  // blind caps so you never look into the void
  const capGeo = makeCaps(positions, SEG, n, pts);

  const centerline = pts.map((v) => [v.x, v.y, v.z]);
  const meta = {
    format: 'k9scope-anatomy@1',
    units: 'cm',
    name: 'Procedural canine upper GI (seed ' + seed + ')',
    landmarks: {
      ues: 0, les: sLES, cardia: sCardia, pylorus: sPyl, duodenalFlexure: sFlex,
      target: Math.min(sEnd - 3, sFlex + 6),
      // a point to look back at when retroflexed (just inside the cardia)
      retroflexTarget: sCardia + 0.5,
    },
    regions: [
      { name: 'Esophagus', from: 0, to: sCardia - 0.5, insufflation: 0.3 },
      { name: 'Cardia', from: sCardia - 0.5, to: sCardia + 3, insufflation: 0.9 },
      { name: 'Stomach - body', from: sCardia + 3, to: sPyl - 7, insufflation: 1.0 },
      { name: 'Stomach - antrum', from: sPyl - 7, to: sPyl - 0.8, insufflation: 0.85 },
      { name: 'Pylorus', from: sPyl - 0.8, to: sPyl + 0.8, insufflation: 0.0 },
      { name: 'Duodenum', from: sPyl + 0.8, to: sEnd + 1, insufflation: 0.25 },
    ],
  };
  return { geometry: geo, capGeometry: capGeo, centerline, meta };
}

function makeCaps(positions, SEG, n, pts) {
  const pos = [], idx = [];
  for (const [ring, inward] of [[0, -1], [n - 1, 1]]) {
    const base = pos.length / 3;
    const c = pts[ring].clone();
    const prev = pts[ring - inward * 4] || pts[ring];
    const out = new THREE.Vector3().subVectors(pts[ring], prev).normalize();
    for (let j = 0; j < SEG; j++) {
      const k = (ring * SEG + j) * 3;
      pos.push(positions[k], positions[k + 1], positions[k + 2]);
    }
    const tip = c.addScaledVector(out, 1.2);
    pos.push(tip.x, tip.y, tip.z);
    for (let j = 0; j < SEG; j++) {
      const a = base + j, b = base + ((j + 1) % SEG);
      if (inward > 0) idx.push(a, b, base + SEG); else idx.push(b, a, base + SEG);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
