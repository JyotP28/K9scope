// Flexible endoscope kinematics + simple lumen interaction.
//
// Model:
//   - The insertion tube follows the lumen centerline, but - like a real
//     scope - a stiff tube rides toward the OUTSIDE of bends (greater
//     curvature of the stomach, outer wall of the duodenal flexure).
//   - The distal bending section (length bendLen) deflects by the up/down and
//     left/right knob angles, in the scope's own frame, which the torque rotates.
//   - The lens sits at the end of the bending section; contact and red-out are
//     computed from the radius table of the LumenModel (fast, mesh-agnostic).
//   - Pylorus: you can only pass if the tip is aimed into the pyloric canal;
//     otherwise the tube buckles along the greater curvature.

import * as THREE from 'three';
import { DEFAULT_LIMITS } from '../common/protocol.js';

const DEG = Math.PI / 180;

export class Scope {
  constructor(model, opts = {}) {
    this.model = model;
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.radius = opts.radius ?? 0.45;     // 9 mm insertion tube
    this.bendLen = opts.bendLen ?? 3.2;    // cm of bending section
    this.stiffness = opts.stiffness ?? 16; // how strongly the tube rides the outer curvature
    this.rollOffset = opts.rollOffset ?? 0; // deg; scope roll at insertion (image orientation)
    this.reset();
  }

  reset() {
    this.depth = 0.5;         // tip arc-length (cm) from the UES
    this.depthTarget = 0.5;
    this.ud = 0; this.lr = 0; // actual tip angulation (deg), lags the knobs slightly
    this.torque = 0;
    this.inflate = 0.5;       // 0.4 = collapsed .. 1 = well insufflated .. 1.15 over-distended
    this.smear = 0;           // lens smear 0..1 (wall contact smears, water washes)
    this.engage = 0;          // pylorus engagement 0..1
    this.engaged = false;
    this.pushing = false;     // pushing against a blocked path
    this.contact = 0;         // 0..1 how hard the tip touches mucosa
    this.redout = 0;          // 0..1 lens against mucosa
    this.inContact = false;
    this.msg = '';
    this.tip = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0), s: 0.5 };
    this.base = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(), up: new THREE.Vector3() };
    this.bendTotal = 0;
  }

  // offset of the stiff tube from the centerline at arc length s
  shaftOffset(s, out) {
    const m = this.model;
    out.set(0, 0, 0);
    const w = 10, step = 0.25;
    let wsum = 0;
    const pyl = m.landmarks.pylorus ?? 1e9;
    for (let k = -w; k <= w; k++) {
      const ss = Math.min(m.length, Math.max(0, s + k * step));
      m.curvatureAt(ss, _k);
      const kap = _k.length();
      const ww = w + 1 - Math.abs(k);
      wsum += ww;
      if (kap < 1e-4) continue;
      _k.multiplyScalar(1 / kap);
      _o.copy(_k).negate(); // outward
      const room = Math.max(0, m.radiusToward(ss, _o, this.inflate) - this.radius - 0.05);
      let mag = Math.min(this.stiffness * kap, 0.6 * room);
      // once the tip is engaged in the pylorus, the tube straightens into it
      const nearPyl = THREE.MathUtils.smoothstep(ss, pyl - 6, pyl - 1.5) * (1 - THREE.MathUtils.smoothstep(ss, pyl + 0.5, pyl + 2));
      mag *= 1 - this.engage * nearPyl;
      out.addScaledVector(_o, mag * ww);
    }
    return out.multiplyScalar(1 / wsum);
  }

  shaftPoint(s, out) {
    this.model.pointAt(s, out);
    return out.add(this.shaftOffset(s, _so));
  }

  update(frame, dt) {
    const m = this.model, L = this.limits;
    const lm = m.landmarks;
    this.msg = '';

    // --- angulation (cable-driven; tip follows knobs quickly) ---
    const ud = Math.max(-L.down, Math.min(L.up, frame.ud));
    const lr = Math.max(-L.left, Math.min(L.right, frame.lr));
    const k = 1 - Math.exp(-dt * 18);
    this.ud += (ud - this.ud) * k;
    this.lr += (lr - this.lr) * k;
    this.torque += (frame.torque - this.torque) * (1 - Math.exp(-dt * 25));

    // --- insufflation ---
    if (frame.air) this.inflate += 0.16 * dt;
    // suction shares the working channel: much weaker with forceps in it
    if (frame.suction) this.inflate -= (frame.tool && frame.tool.inserted ? 0.08 : 0.30) * dt;
    this.inflate -= 0.006 * dt; // slow leak past the scope
    this.inflate = Math.max(0.4, Math.min(1.2, this.inflate));
    if (frame.water) this.smear = Math.max(0, this.smear - 1.6 * dt);
    else this.smear = Math.max(0, this.smear - 0.015 * dt);

    // --- insertion with resistance & pylorus gate ---
    let ins = frame.insert;
    if (ins > 0 && this.contact > 0.35) ins *= 0.3;            // pushing into the wall
    this.depthTarget = Math.max(0.3, Math.min(m.length - 1.0, this.depthTarget + ins));

    const pyl = lm.pylorus;
    this.pushing = false;
    if (pyl !== undefined) {
      const gate = pyl - 1.4;
      if (!this.engaged && this.depth > gate - 2.5) {
        // aim check: is the lens looking into the pyloric canal?
        m.pointAt(pyl, _p);
        _d.subVectors(_p, this.tip.pos);
        const dist = _d.length();
        const ang = Math.acos(Math.min(1, Math.max(-1, _d.normalize().dot(this.tip.fwd)))) / DEG;
        this.pylAim = ang;
        if (ang < 22 && dist < 6.5 && m.inflateScale(this.tip.s, this.inflate) > 0.6) this.engaged = true;
      }
      if (this.engaged && this.depthTarget < gate - 3) this.engaged = false;
      if (!this.engaged && this.depthTarget > gate) {
        if (ins > 0) this.pushing = true;
        this.depthTarget = gate;
      }
      this.engage += ((this.engaged ? 1 : 0) - this.engage) * (1 - Math.exp(-dt * 4));
    }
    this.depth += (this.depthTarget - this.depth) * (1 - Math.exp(-dt * 14));

    // --- pose of the start of the bending section ---
    const sb = Math.max(0.05, this.depth - this.bendLen);
    this.shaftPoint(sb, this.base.pos);
    this.shaftPoint(Math.max(0, sb - 0.4), _a);
    this.shaftPoint(Math.min(m.length, sb + 0.4), _b);
    this.base.fwd.subVectors(_b, _a).normalize();
    m.normalAt(sb, _n);
    _n.addScaledVector(this.base.fwd, -_n.dot(this.base.fwd)).normalize();
    // torque rotates the whole scope about its own axis (clockwise from operator's view = +).
    // A positive rotation about the forward axis is clockwise when looking down the scope.
    // rollOffset = how the scope is held at insertion (calibrated by Orientation.js).
    _q.setFromAxisAngle(this.base.fwd, (this.torque + this.rollOffset) * DEG);
    this.base.up.copy(_n).applyQuaternion(_q);
    _r.crossVectors(this.base.fwd, this.base.up); // scope "right"

    // --- bending section: constant-curvature arc ---
    const tu = this.ud * DEG, tl = this.lr * DEG;
    const th = Math.hypot(tu, tl);
    this.bendTotal = th / DEG;
    const tip = this.tip;
    if (th < 1e-4) {
      tip.pos.copy(this.base.pos).addScaledVector(this.base.fwd, this.bendLen);
      tip.fwd.copy(this.base.fwd);
      tip.up.copy(this.base.up);
    } else {
      _dir.copy(this.base.up).multiplyScalar(tu / th).addScaledVector(_r, tl / th);
      const Lb = this.bendLen;
      tip.pos.copy(this.base.pos)
        .addScaledVector(this.base.fwd, Lb * Math.sin(th) / th)
        .addScaledVector(_dir, Lb * (1 - Math.cos(th)) / th);
      _ax.crossVectors(this.base.fwd, _dir).normalize();
      _q.setFromAxisAngle(_ax, th);
      tip.fwd.copy(this.base.fwd).applyQuaternion(_q);
      tip.up.copy(this.base.up).applyQuaternion(_q);
    }

    // --- wall contact: keep the lens inside the lumen ---
    let loc = m.locate(tip.pos, this.depth, this.inflate);
    const gap = loc.gap - this.radius;
    this.contact = 0;
    if (gap < 0) {
      this.contact = Math.min(1, -gap / 0.5);
      // push the tip back inside (mucosa is compliant: allow 0.15 cm indentation)
      const allow = 0.15;
      if (-gap > allow) {
        m.pointAt(loc.s, _p);
        _d.subVectors(tip.pos, _p);
        _t.copy(m.tangentAt(loc.s, _t));
        _d.addScaledVector(_t, -_d.dot(_t));
        const r = _d.length();
        if (r > 1e-5) tip.pos.addScaledVector(_d, -(-gap - allow) / r);
      }
    }
    tip.s = loc.s;

    // --- red-out: how close is the mucosa straight ahead of the lens? ---
    let tWall = 3;
    for (let t = 0.05; t <= 3; t += 0.1) {
      _p.copy(tip.pos).addScaledVector(tip.fwd, t);
      const l = m.locate(_p, tip.s, this.inflate);
      if (l.gap < 0) { tWall = t; break; }
    }
    this.wallAhead = tWall;
    this.redout = Math.max(this.contact * 0.8, THREE.MathUtils.clamp(1 - (tWall - 0.08) / 0.45, 0, 1));
    if (this.pushing) { this.redout = Math.max(this.redout, 0.85); this.contact = Math.max(this.contact, 0.6); }
    this.inContact = this.contact > 0.3 || this.redout > 0.75;
    this.wallGap = gap; // radial clearance of the lens (cm), used for auto-exposure
    if (this.inContact) this.smear = Math.min(1, this.smear + dt * 0.35 * (0.3 + this.contact));

    if (this.pushing) this.msg = 'Pylorus not aligned - withdraw slightly and aim the tip into the pyloric canal';
    else if (this.redout > 0.7) this.msg = 'Red-out: lens against mucosa - withdraw / insufflate';
    return this;
  }

  // points along the scope (for the guide view and the retroflexed shaft)
  scopePolyline(fromS, count = 60) {
    const pts = [];
    const sb = Math.max(0.05, this.depth - this.bendLen);
    const s0 = Math.max(0, fromS);
    for (let i = 0; i <= count; i++) {
      const s = s0 + (sb - s0) * (i / count);
      pts.push(this.shaftPoint(s, new THREE.Vector3()));
    }
    // bending arc
    const tu = this.ud * DEG, tl = this.lr * DEG, th = Math.hypot(tu, tl);
    _r.crossVectors(this.base.fwd, this.base.up);
    for (let i = 1; i <= 12; i++) {
      const f = i / 12, a = th * f, l = this.bendLen * f;
      const p = this.base.pos.clone();
      if (th < 1e-4) p.addScaledVector(this.base.fwd, l);
      else {
        _dir.copy(this.base.up).multiplyScalar(tu / th).addScaledVector(_r, tl / th);
        p.addScaledVector(this.base.fwd, (this.bendLen / th) * Math.sin(a)).addScaledVector(_dir, (this.bendLen / th) * (1 - Math.cos(a)));
      }
      pts.push(p);
    }
    return pts;
  }
}

const _k = new THREE.Vector3(), _o = new THREE.Vector3(), _so = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3(), _r = new THREE.Vector3();
const _q = new THREE.Quaternion(), _dir = new THREE.Vector3(), _ax = new THREE.Vector3();
const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _t = new THREE.Vector3();
