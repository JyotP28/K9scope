// Load / export anatomy as glTF (.glb) + metadata.
//
// A k9scope anatomy file is a normal glTF/GLB containing:
//   - one or more meshes = the mucosal surface (merged at load time)
//   - metadata (centerline, landmarks, regions) EITHER in the scene's
//     extras (scene.userData.k9scope after loading) OR in a sidecar JSON
//     next to it with the same name:  stomach.glb + stomach.json
//
// Sidecar / extras format (units: cm unless "units": "mm" or "m"):
// {
//   "format": "k9scope-anatomy@1",
//   "units": "cm",
//   "centerline": [[x,y,z], ...],          // entry (UES) -> distal end, any spacing
//   "landmarks": { "cardia": 28.4,         // arc length along centerline (cm) ...
//                  "pylorus": [x,y,z], ... }// ...or a 3D point (projected onto centerline)
//   "regions": [ { "name": "Esophagus", "from": 0, "to": 28, "insufflation": 0.3 }, ... ]
// }
// Required landmarks for the training task: cardia, pylorus, target.
// Optional: les, duodenalFlexure, retroflexTarget.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const UNIT = { cm: 1, mm: 0.1, m: 100 };

export async function loadAnatomyGLB(url, sidecarUrl = null) {
  const gltf = await new GLTFLoader().loadAsync(url);
  let meta = gltf.scene.userData && gltf.scene.userData.k9scope;
  if (!meta) {
    const side = sidecarUrl || url.replace(/\.(glb|gltf)(\?.*)?$/i, '.json');
    const r = await fetch(side);
    if (!r.ok) throw new Error('No k9scope metadata in the glTF and no sidecar at ' + side);
    meta = await r.json();
  }
  return fromGLTF(gltf, meta);
}

export async function loadAnatomyFiles(fileList) {
  const files = [...fileList];
  const glbF = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
  const jsonF = files.find((f) => /\.json$/i.test(f.name));
  if (!glbF) throw new Error('Choose a .glb file (and optionally its .json sidecar)');
  const buf = await glbF.arrayBuffer();
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  let meta = gltf.scene.userData && gltf.scene.userData.k9scope;
  if (jsonF) meta = JSON.parse(await jsonF.text());
  if (!meta) throw new Error('No metadata: include the .json sidecar with the centerline');
  return fromGLTF(gltf, meta);
}

function fromGLTF(gltf, meta) {
  const scale = UNIT[meta.units || 'cm'] ?? 1;
  const geos = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (o.isMesh && !(o.userData && o.userData.k9cap)) {
      let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
      // keep only what we need so differently-attributed meshes merge
      const keep = new THREE.BufferGeometry();
      keep.setAttribute('position', g.attributes.position);
      if (g.attributes.normal) keep.setAttribute('normal', g.attributes.normal);
      if (g.attributes.color) keep.setAttribute('color', toFloatColor(g.attributes.color));
      const fold = g.attributes._fold || g.attributes._FOLD || g.attributes.fold;
      if (fold) keep.setAttribute('fold', fold);
      if (g.attributes.uv) keep.setAttribute('uv', g.attributes.uv);
      if (g.index) keep.setIndex(g.index);
      geos.push(keep);
    }
  });
  if (!geos.length) throw new Error('glTF contains no meshes');
  let geo = geos.length === 1 ? geos[0] : mergeGeometries(geos.map(normalizeAttrs), false);
  if (scale !== 1) geo.scale(scale, scale, scale);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const centerline = meta.centerline.map((p) => [p[0] * scale, p[1] * scale, p[2] * scale]);
  const lm = {};
  for (const [k, v] of Object.entries(meta.landmarks || {})) lm[k] = Array.isArray(v) ? v.map((x) => x * scale) : v * scale;
  return { geometry: geo, capGeometry: null, centerline, meta: { ...meta, landmarks: lm } };
}

function toFloatColor(attr) {
  if (attr.array instanceof Float32Array) return attr;
  const out = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) { out[i * 3] = attr.getX(i); out[i * 3 + 1] = attr.getY(i); out[i * 3 + 2] = attr.getZ(i); }
  return new THREE.BufferAttribute(out, 3);
}
function normalizeAttrs(g) {
  // mergeGeometries needs identical attribute sets
  const n = g.attributes.position.count;
  if (!g.attributes.color) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.85), 3));
  if (!g.attributes.fold) g.setAttribute('fold', new THREE.BufferAttribute(new Float32Array(n), 1));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g.index ? g : g;
}

// Export anatomy data ({geometry, centerline, meta}) to a GLB (metadata embedded
// in scene extras) and the same metadata as a sidecar JSON. Returns {glb: ArrayBuffer, json: string}.
export async function exportAnatomy(data) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', data.geometry.attributes.position);
  g.setAttribute('normal', data.geometry.attributes.normal);
  if (data.geometry.attributes.color) g.setAttribute('color', data.geometry.attributes.color);
  if (data.geometry.attributes.uv) g.setAttribute('uv', data.geometry.attributes.uv);
  if (data.geometry.attributes.fold) g.setAttribute('_fold', data.geometry.attributes.fold);
  g.setIndex(data.geometry.index);
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.name = 'mucosa';
  const scene = new THREE.Scene();
  scene.add(mesh);
  const meta = { ...data.meta, centerline: data.centerline.map((p) => p.map((x) => +x.toFixed(3))) };
  scene.userData.k9scope = meta;
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
  return { glb, json: JSON.stringify(meta) };
}
