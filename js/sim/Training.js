// Training task v1: esophagus -> stomach -> pylorus -> duodenum.
// Tracks time, wall contacts, insertion depth, over-insufflation, optional retroflexion.
// 'biopsy' mode adds a biopsy protocol: retrieve samples from each target region.

import * as THREE from 'three';

// samples required per region in biopsy mode (region names from the anatomy metadata).
// Kept small for practice; real protocols take more (e.g. several per region).
export const BIOPSY_TARGETS = { 'Stomach - body': 2, 'Stomach - antrum': 2, 'Duodenum': 2 };
const QUALITY_VALUE = { good: 1, adequate: 0.75, poor: 0.4 };

export class Training {
  constructor(model, mode = 'nav') {
    this.model = model;
    this.mode = mode;
    this.reset();
  }

  // a sample retrieved from the forceps
  addSample(sample) {
    if (this.state === 'ready') this.state = 'running';
    this.samples.push({ ...sample, t: this.t });
  }
  samplesIn(region) { return this.samples.filter((x) => x.region === region); }
  biopsyDone() {
    return Object.entries(BIOPSY_TARGETS).every(([r, n]) => this.samplesIn(r).length >= n);
  }

  reset() {
    const lm = this.model.landmarks;
    this.state = 'ready';
    this.t = 0;
    this.contacts = 0;
    this.contactTime = 0;
    this.overInflTime = 0;
    this.maxDepth = 0;
    this._wasContact = false;
    this._contactCooldown = 0;
    this.milestones = [
      { id: 'les', label: 'Pass the lower esophageal sphincter', s: lm.les ?? (lm.cardia - 1), done: false },
      { id: 'stomach', label: 'Enter the stomach', s: (lm.cardia ?? 0) + 2, done: false },
      { id: 'pylorus', label: 'Traverse the pylorus', s: (lm.pylorus ?? 0) + 1.0, done: false },
      { id: 'duodenum', label: 'Advance into the descending duodenum', s: lm.target, done: false },
    ];
    this.retroflex = { done: false, label: 'Bonus: retroflex to view the cardia (J-maneuver)' };
    this.events = [];
    this.samples = [];
    this.lostSamples = 0;
    this.missedBites = 0;
    this.unsafeMoves = 0;
  }

  update(scope, dt) {
    const ev = this.events = [];
    if (this.state === 'done') return ev;
    if (this.state === 'ready') {
      if (scope.depth > 1.5) { this.state = 'running'; ev.push({ type: 'start' }); }
      else return ev;
    }
    this.t += dt;
    this.maxDepth = Math.max(this.maxDepth, scope.depth);

    // contacts (debounced rising edges)
    this._contactCooldown -= dt;
    if (scope.inContact) {
      this.contactTime += dt;
      if (!this._wasContact && this._contactCooldown <= 0) {
        this.contacts++;
        ev.push({ type: 'contact' });
      }
      this._contactCooldown = 0.5;
    }
    this._wasContact = scope.inContact;
    if (scope.inflate > 1.05) this.overInflTime += dt;

    for (const m of this.milestones) {
      if (!m.done && scope.depth >= m.s && scope.tip.s >= m.s - 1.5) {
        m.done = true; m.time = this.t;
        ev.push({ type: 'milestone', label: m.label });
      }
    }
    // retroflexion: lens in the stomach, looking back at the cardia
    const lm = this.model.landmarks;
    if (!this.retroflex.done && lm.retroflexTarget !== undefined && scope.bendTotal > 120) {
      const p = this.model.pointAt(lm.retroflexTarget, new THREE.Vector3());
      const d = p.sub(scope.tip.pos);
      const dist = d.length();
      const ang = Math.acos(THREE.MathUtils.clamp(d.normalize().dot(scope.tip.fwd), -1, 1)) * 180 / Math.PI;
      if (ang < 30 && dist < 10 && scope.tip.s > lm.cardia + 1) {
        this.retroflex.done = true; this.retroflex.time = this.t;
        ev.push({ type: 'milestone', label: 'Retroflexion: cardia visualised' });
      }
    }
    if (this.milestones.every((m) => m.done) && (this.mode !== 'biopsy' || this.biopsyDone())) {
      this.state = 'done';
      ev.push({ type: 'finish', result: this.result() });
    }
    return ev;
  }

  result() {
    const time = this.t;
    const B = this.mode === 'biopsy';
    // biopsy mode: more time allowed, and 25 points move from time/contacts to the biopsies
    const timeMax = B ? 25 : 40, contactMax = B ? 30 : 40;
    const tFull = B ? 240 : 90, tZero = B ? 600 : 300;
    const timeScore = Math.round(timeMax * THREE.MathUtils.clamp(1 - (time - tFull) / (tZero - tFull), 0, 1));
    const contactScore = Math.max(0, contactMax - (B ? 4 : 5) * this.contacts);
    const inflScore = Math.max(0, Math.round(10 - 2 * (this.overInflTime / 5)));
    const bonus = this.retroflex.done ? 10 : 0;
    let biopsyScore = 0;
    const biopsy = [];
    if (B) {
      let got = 0, need = 0;
      for (const [r, n] of Object.entries(BIOPSY_TARGETS)) {
        const xs = this.samplesIn(r).slice().sort((a, b) => QUALITY_VALUE[b.quality] - QUALITY_VALUE[a.quality]).slice(0, n);
        got += xs.reduce((a, x) => a + QUALITY_VALUE[x.quality], 0); need += n;
        biopsy.push({ region: r, n: this.samplesIn(r).length, need: n, q: xs.map((x) => x.quality) });
      }
      biopsyScore = Math.max(0, Math.round(25 * got / need) - 3 * this.unsafeMoves - this.lostSamples);
    }
    const total = Math.min(100, timeScore + contactScore + inflScore + bonus + biopsyScore);
    const grade = total >= 90 ? 'Excellent' : total >= 75 ? 'Good' : total >= 55 ? 'Fair' : 'Keep practising';
    return {
      time, contacts: this.contacts, contactTime: this.contactTime, overInflTime: this.overInflTime,
      maxDepth: this.maxDepth, retroflex: this.retroflex.done,
      parts: { timeScore, contactScore, inflScore, bonus, biopsyScore, timeMax, contactMax }, total, grade,
      mode: this.mode, biopsy, samples: this.samples.slice(), lostSamples: this.lostSamples, missedBites: this.missedBites, unsafeMoves: this.unsafeMoves,
      splits: this.milestones.map((m) => ({ label: m.label, time: m.time })),
    };
  }
}
