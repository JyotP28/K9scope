// Endoscope view renderer.
//  pass 1: scene rendered from the scope tip with a wide rectilinear camera into a square target
//  pass 2: fisheye (equidistant) re-projection + octagonal endoscope mask + red-out + lens smear
//  inset:  optional "scope guide" overview (like a magnetic scope-position imager)

import * as THREE from 'three';

const SRC_FOV = 140;   // deg, rectilinear source
const OUT_FOV = 140;   // deg, fisheye output diagonal-ish field of view

export class EndoRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.autoClear = false;
    this.r = r;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(SRC_FOV, 1, 0.03, 80);
    this.scene.add(this.camera);

    // light guides at the tip: strong, close, falls off with distance squared
    this.light = new THREE.PointLight(0xfff4e8, 2.6, 0, 2);
    this.light.position.set(0, 0, 0.05);
    this.camera.add(this.light);
    this.fill = new THREE.PointLight(0xffe0d8, 0.5, 0, 2);
    this.fill.position.set(0, 0.25, -0.3);
    this.camera.add(this.fill);
    this.scene.add(new THREE.AmbientLight(0x401010, 0.02));

    this.target = new THREE.WebGLRenderTarget(1024, 1024, { type: THREE.HalfFloatType, samples: 4 });
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this.post = this._makePost();
    this.inflateUniform = { value: 0.5 };

    // overview ("scope guide")
    this.guide = { enabled: true, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1, 1, 400) };
    this.guide.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(20, 30, 40); this.guide.scene.add(dl);
    this.scopeLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x58d0ff }));
    this.scopeLine.frustumCulled = false;
    this.guide.scene.add(this.scopeLine);
    this.tipDot = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffe066 }));
    this.guide.scene.add(this.tipDot);

    // dark scope shaft (visible when retroflexed)
    this.shaftMat = new THREE.MeshPhysicalMaterial({ color: 0x2c3236, roughness: 0.3, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.1 });
    this.shaftMesh = null;

    this.view = { x: 0, y: 0, size: 100 };
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setAnatomy(model, capGeometry) {
    if (this.lumen) { this.scene.remove(this.lumen); this.lumen.geometry.dispose(); }
    if (this.caps) { this.scene.remove(this.caps); }
    if (this.guideMesh) { this.guide.scene.remove(this.guideMesh); }
    const geo = model.geometry;
    const hasFold = !!geo.attributes.fold;
    if (!hasFold) geo.setAttribute('fold', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
    const hasColor = !!geo.attributes.color;

    const mat = new THREE.MeshPhysicalMaterial({
      color: hasColor ? 0xffffff : 0xe08080,
      vertexColors: hasColor,
      roughness: 0.42,
      metalness: 0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.2,
      sheen: 0.4, sheenColor: new THREE.Color(0xff9a8a), sheenRoughness: 0.5,
      normalMap: mucosaNormalMap(),
      normalScale: new THREE.Vector2(0.55, 0.55),
      clearcoatNormalMap: mucosaNormalMap(),
      clearcoatNormalScale: new THREE.Vector2(0.08, 0.08),
      side: THREE.DoubleSide,
    });
    const infl = this.inflateUniform;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uInflate = infl;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aCenter; attribute float aInflate; attribute float fold; uniform float uInflate;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            vec3 rel = transformed - aCenter;
            float sc = mix(1.0, uInflate, aInflate);
            // rugae flatten as the stomach is distended
            float flatn = clamp((uInflate - 0.55) / 0.5, 0.0, 1.0) * 0.75 * aInflate;
            vec3 rd = normalize(rel + 1e-5);
            transformed = aCenter + rel * sc + rd * fold * flatn;
          }`);
    };
    this.lumen = new THREE.Mesh(geo, mat);
    this.lumen.frustumCulled = false;
    this.scene.add(this.lumen);
    if (capGeometry) {
      this.caps = new THREE.Mesh(capGeometry, new THREE.MeshStandardMaterial({ color: 0x6a2222, roughness: 0.6, side: THREE.DoubleSide }));
      this.scene.add(this.caps);
    }
    // guide: translucent organ
    this.guideMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xd88880, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
    this.guide.scene.add(this.guideMesh);
    geo.computeBoundingSphere();
    const bs = geo.boundingSphere;
    this.guide.center = bs.center.clone();
    this.guide.camera.position.copy(bs.center).add(new THREE.Vector3(-bs.radius * 0.4, -bs.radius * 2.7, bs.radius * 0.2));
    this.guide.camera.up.set(0, 0, 1);
    this.guide.camera.lookAt(bs.center);
  }

  _makePost() {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        uHalfSrc: { value: (SRC_FOV / 2) * Math.PI / 180 },
        uHalfOut: { value: (OUT_FOV / 2) * Math.PI / 180 },
        uRed: { value: 0 },
        uSmear: { value: 0 },
        uTime: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tSrc; uniform float uHalfSrc, uHalfOut, uRed, uSmear, uTime; uniform vec2 uRes;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        vec3 sampleFish(vec2 q){
          // q in [-1,1]; equidistant fisheye: angle proportional to radius
          float r = length(q);
          float ang = r * uHalfOut;
          float rs = tan(min(ang, 1.55)) / tan(uHalfSrc);
          vec2 uv = 0.5 + 0.5 * (r > 1e-5 ? q / r * rs : vec2(0.0));
          return texture2D(tSrc, uv).rgb;
        }
        void main(){
          vec2 q = vUv * 2.0 - 1.0;
          // octagonal endoscope mask (corners clipped)
          float oct = max(abs(q.x), abs(q.y)) * 0.92 + (abs(q.x) + abs(q.y)) * 0.0;
          float diag = (abs(q.x) + abs(q.y)) * 0.70710678;
          float m = max(max(abs(q.x), abs(q.y)), (abs(q.x) + abs(q.y)) * 0.68);
          float mask = 1.0 - smoothstep(0.975, 0.99, m);
          if (mask <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          vec2 qq = q * 0.995;
          vec3 c = sampleFish(qq);
          // lens smear / red-out blur
          float blur = uSmear * 0.03 + uRed * 0.05;
          if (blur > 0.001) {
            vec3 acc = c; float w = 1.0;
            for (int i = 0; i < 12; i++) {
              float a = float(i) * 0.5236 + hash(q + float(i)) * 0.3;
              float rr = blur * (0.4 + 0.6 * fract(float(i) * 0.618));
              acc += sampleFish(qq + vec2(cos(a), sin(a)) * rr); w += 1.0;
            }
            c = acc / w;
            c = mix(c, vec3(dot(c, vec3(0.4, 0.35, 0.25))) * vec3(1.05, 0.95, 0.9), uSmear * 0.25);
          }
          // red-out: lens against mucosa -> diffuse saturated red
          vec3 redCol = vec3(0.75, 0.06, 0.05) * (0.8 + 0.2 * sin(uTime * 2.0 + q.x * 3.0));
          c = mix(c, redCol, smoothstep(0.0, 1.0, uRed));
          // vignette + sensor noise
          float r = length(q);
          c *= 1.0 - 0.35 * pow(r, 2.5);
          c += (hash(q * uRes + uTime) - 0.5) * 0.015;
          gl_FragColor = vec4(c * mask, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const scene = new THREE.Scene(); scene.add(quad);
    return { mat, scene, cam: new THREE.Camera() };
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.r.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    // endoscope image: big square, offset right to leave room for the "tower" info column
    const size = Math.min(h * 0.96, w - 300);
    this.view = { x: Math.max(280, (w - size) / 2 + 120), y: (h - size) / 2, size: Math.max(200, size) };
    const pr = this.r.getPixelRatio();
    const t = Math.min(2048, Math.round(this.view.size * pr));
    this.target.setSize(t, t);
    this.post.mat.uniforms.uRes.value.set(t, t);
  }

  updateShaft(scope) {
    const show = scope.bendTotal > 95;
    if (!show) { if (this.shaftMesh) this.shaftMesh.visible = false; return; }
    const pts = scope.scopePolyline(scope.depth - scope.bendLen - 22, 40);
    // drop the last few points near the lens so we don't see the inside of our own tube
    const usable = pts.slice(0, pts.length - 5);
    if (usable.length < 3) return;
    const curve = new THREE.CatmullRomCurve3(usable);
    const g = new THREE.TubeGeometry(curve, 60, scope.radius, 14, false);
    if (this.shaftMesh) { this.shaftMesh.geometry.dispose(); this.shaftMesh.geometry = g; this.shaftMesh.visible = true; }
    else { this.shaftMesh = new THREE.Mesh(g, this.shaftMat); this.scene.add(this.shaftMesh); }
  }

  render(scope, time) {
    const cam = this.camera, tip = scope.tip;
    cam.position.copy(tip.pos);
    cam.up.copy(tip.up);
    cam.lookAt(tip.pos.clone().add(tip.fwd));
    cam.updateMatrixWorld();
    this.inflateUniform.value = scope.inflate;
    // video processor auto-exposure: darken when the lens is close to mucosa
    const near = Math.min(scope.wallGap ?? 1, (scope.wallAhead ?? 3) * 0.5);
    const want = 0.5 + 0.65 * THREE.MathUtils.smoothstep(near, 0.0, 1.4);
    this.exposure = (this.exposure ?? want) + (want - (this.exposure ?? want)) * 0.12;
    this.r.toneMappingExposure = this.exposure;
    this.updateShaft(scope);

    const r = this.r;
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(this.scene, cam);

    r.setRenderTarget(null);
    r.setClearColor(0x050607, 1);
    r.setScissorTest(false);
    r.clear();
    const u = this.post.mat.uniforms;
    u.tSrc.value = this.target.texture;
    u.uRed.value = scope.redout;
    u.uSmear.value = scope.smear;
    u.uTime.value = time;
    const H = window.innerHeight;
    const v = this.view;
    r.setViewport(v.x, H - v.y - v.size, v.size, v.size);
    r.render(this.post.scene, this.post.cam);

    if (this.guide.enabled && this.guideMesh) {
      const pts = scope.scopePolyline(0, 120);
      this.scopeLine.geometry.dispose();
      this.scopeLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      this.tipDot.position.copy(tip.pos);
      this.guideMesh.material.opacity = 0.28;
      const gs = Math.round(Math.min(220, window.innerHeight * 0.27));
      const gx = window.innerWidth - gs - 12;
      r.setViewport(gx, 12, gs, gs);
      r.setScissor(gx, 12, gs, gs);
      r.setScissorTest(true);
      r.setClearColor(0x0d1114, 1);
      r.clear();
      r.render(this.guide.scene, this.guide.camera);
      r.setScissorTest(false);
    }
  }
}

let _normalTex = null;
function mucosaNormalMap() {
  if (_normalTex) return _normalTex;
  // tileable bumpy mucosa: sum of soft blobs -> height -> normals
  const S = 256;
  const h = new Float32Array(S * S);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < 900; k++) {
    const cx = rnd() * S, cy = rnd() * S, rad = 2 + rnd() * 7, amp = 0.4 + rnd();
    for (let y = -rad * 2; y <= rad * 2; y++) for (let x = -rad * 2; x <= rad * 2; x++) {
      const d2 = (x * x + y * y) / (rad * rad);
      if (d2 > 4) continue;
      const X = ((Math.floor(cx + x) % S) + S) % S, Y = ((Math.floor(cy + y) % S) + S) % S;
      h[Y * S + X] += amp * Math.exp(-d2 * 1.5);
    }
  }
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const hx = h[y * S + ((x + 1) % S)] - h[y * S + ((x - 1 + S) % S)];
    const hy = h[((y + 1) % S) * S + x] - h[((y - 1 + S) % S) * S + x];
    const nx = -hx * 0.9, ny = -hy * 0.9, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    const i = (y * S + x) * 4;
    data[i] = (nx / l * 0.5 + 0.5) * 255; data[i + 1] = (ny / l * 0.5 + 0.5) * 255; data[i + 2] = (nz / l * 0.5 + 0.5) * 255; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  _normalTex = t;
  return t;
}
