// Training task v1: esophagus -> stomach -> pylorus -> duodenum.
// Tracks time, wall contacts, insertion depth, over-insufflation, optional retroflexion.

import * as THREE from 'three';

export class Training {
  constructor(model) {
    this.model = model;
    this.reset();
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
    if (this.milestones.every((m) => m.done)) {
      this.state = 'done';
      ev.push({ type: 'finish', result: this.result() });
    }
    return ev;
  }

  result() {
    const time = this.t;
    const timeScore = Math.round(40 * THREE.MathUtils.clamp(1 - (time - 90) / 210, 0, 1));
    const contactScore = Math.max(0, 40 - 5 * this.contacts);
    const inflScore = Math.max(0, Math.round(10 - 2 * (this.overInflTime / 5)));
    const bonus = this.retroflex.done ? 10 : 0;
    const total = Math.min(100, timeScore + contactScore + inflScore + bonus);
    const grade = total >= 90 ? 'Excellent' : total >= 75 ? 'Good' : total >= 55 ? 'Fair' : 'Keep practising';
    return {
      time, contacts: this.contacts, contactTime: this.contactTime, overInflTime: this.overInflTime,
      maxDepth: this.maxDepth, retroflex: this.retroflex.done,
      parts: { timeScore, contactScore, inflScore, bonus }, total, grade,
      splits: this.milestones.map((m) => ({ label: m.label, time: m.time })),
    };
  }
}
