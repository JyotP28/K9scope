# K9 Scope Sim — canine upper GI endoscopy trainer (prototype v0.1)

Practice flexible-endoscope handling without a real scope or an instructor.

* **Phone (left hand)** = the control section: up/down wheel, right/left ring, air/water and suction valves, locks, gyro torque.
* **Laptop** = the video tower: live fisheye endoscope view of a procedurally generated canine esophagus → stomach → pylorus → duodenum.
* **Right hand** = mouse wheel / two-finger trackpad scroll to advance and withdraw the insertion tube.

Everything is static HTML/JS (no build step, no server code), so it runs on GitHub Pages.

---

## Run it

### Quickest: GitHub Pages (recommended — phones need https for the gyroscope)

1. Create a new GitHub repository (e.g. `k9scope`) and upload **all files in this folder** (keep the folder structure; include the empty `.nojekyll` file).
2. Repo → **Settings → Pages** → *Source: Deploy from a branch* → branch `main`, folder `/ (root)` → Save.
3. After ~1 minute open `https://<your-username>.github.io/k9scope/` on the laptop (Chrome or Safari).
4. Scan the QR code with the phone camera → tap **Tap to start** → on iPhone, allow *Motion & Orientation*.
5. Hold the phone upright in your left hand and press **Zero torque** once you're holding it comfortably.

### Locally on the laptop (keyboard / testing)

Modules can't load from `file://`, so start any static server in this folder:

```bash
cd k9scope
python3 -m http.server 8000
# open http://localhost:8000
```

* Phone pairing still works locally (the QR points at your laptop's address only if you open the page via its LAN IP, e.g. `http://192.168.1.23:8000`), **but phones block motion sensors on plain http**, so torque falls back to an on-screen drag strip. Use the Pages URL for the full phone experience.
* **No phone at all?** Use the keyboard (press **H** in the sim for the list).
* **Test the phone UI on the laptop:** open `http://localhost:8000/?local` and, in the same browser, `http://localhost:8000/phone.html?local#<room>` (the sim shows the exact link). This uses a local BroadcastChannel instead of WebRTC.

### On campus / restricted Wi-Fi: Ably relay

School and enterprise networks usually block peer-to-peer WebRTC, so the phone never connects (the laptop page suggests switching after ~25 s). Use the **Ably** relay instead. It runs over a normal secure websocket on port 443, like any website.

1. Make a free account at [ably.com](https://ably.com) and create an app.
2. In the app's **API Keys** tab, create a **new restricted key**: capability *Selected channels* `k9scope:*` with only **publish, subscribe, presence** ticked. Don't use the default root key. The key ends up on students' phones, so restrict it, and you can revoke or rotate it anytime.
3. On the laptop sim: **Settings → Phone connection → Ably relay**, paste the key, **Save & reconnect**.
4. Scan the QR code as usual. The key rides along in the link's `#fragment`, which browsers never send to the web server. The phone saves it and removes it from the address bar. If you untick "Put the key in the QR code", enter it once in the phone's ⚙ settings instead.

The key is stored only in each browser's local storage and is never part of the files you upload to GitHub.

**Usage and quota (free plan: 6 M messages/month, 200 connections, 50 msg/s per connection).** Ably counts each publish *and* each delivery. To stay well inside that, the phone sends its state at most **20×/s**, and only when something changes. Idle, it sends a keep-alive once per second, with latency pings every 5 s. Forceps status from the laptop goes at most 5×/s. Worst case (dials moving non-stop) that's about 40 counted messages/s, roughly 145 k/hour, so about 40 hours of constant knob-twiddling per month. Real sessions are mostly idle and use far less. Latency goes via Ably's nearest data centre, typically a few tens of ms; it's shown on both screens.

---

## Controls

| Action | Phone | Keyboard / mouse |
|---|---|---|
| Tip up / down | inner wheel, circular thumb swipe (counter-clockwise = **U**) | ↑ / ↓ |
| Tip right / left | outer ring (clockwise = **R**) | → / ← |
| Torque | rotate the whole phone about its long axis | Q / E |
| Advance / withdraw | — (right hand) | scroll wheel / trackpad, or W / S |
| Air (insufflate) | hold blue valve | Space |
| Water (lens wash) | hold blue valve and slide thumb down | R |
| Suction | hold red valve | X |
| Straighten tip | *Release / straighten tip* | Z |
| Lock a dial | lock buttons beside the dial | — |
| Insert / withdraw biopsy forceps | **FORCEPS** button | B |
| Advance / retract forceps | drag the forceps strip | Shift + scroll, or M / N |
| Open forceps jaws (release = bite) | hold **JAWS** | hold left mouse button on the image, or J |
| Light source brighter / dimmer | — | + / − (or Settings) |
| Zero torque | *Zero torque* | — |

Dials hold their position when released. Deflection limits: up 210°, down 90°, right/left 100° (typical 9 mm GI scope; change `DEFAULT_LIMITS` in `js/common/protocol.js`). Directions can be inverted in the phone's ⚙ settings and the sim's Settings (scroll direction, torque).

## The training task

Advance from the esophagus through the stomach and pylorus into the descending duodenum.

* The stomach starts **partially collapsed** — insufflate to open it up (rugal folds flatten as it distends). Over-insufflation (bar past the orange mark) costs points.
* **Wall contact** → red-out, a warning, a haptic buzz on Android, and a smeared lens (wash it with water).
* The **pylorus only opens to a tip that is aimed into the canal**; pushing blindly makes the tube buckle along the greater curvature.
* The duodenal flexure needs up-deflection plus some right/left/torque to pass without contact.
* **Bonus:** retroflex (full up) in the gastric body to view the cardia — you'll see your own insertion tube.
* Score = time (40) + contact avoidance (40) + insufflation control (10) + retroflexion (10).

The bottom-right *scope guide* shows where the scope is (toggle with **G**; **V** or click its title to switch between ventrodorsal and right-lateral views). The yellow stick at the tip shows which way the **top of the endoscope image** points in the patient. **Settings → New random patient** varies the anatomy.

## Biopsy

1. Insert the forceps (**B** or the phone's FORCEPS button). They take about a second to pass the channel and emerge at about **7 o'clock** in the image.
2. Position the tip **1–2 cm** from the target. Too close and there's no room to open the jaws, and the status line says so.
3. Advance the forceps a little, **open the jaws**, push them onto the mucosa (status shows "on mucosa"), then **release to close**. A bleeding biopsy site appears where you bit.
4. **Withdraw the forceps completely** to retrieve the sample (one bite per pass). Opening the jaws again before retrieval drops the sample.

* **Sample quality:** en-face bites (forceps roughly perpendicular to the wall) are graded *good*, oblique bites *adequate* and tangential bites *poor*.
* **Errors tracked:** closing in the lumen counts as a missed bite. Moving the scope more than about 1 cm with the forceps extended is flagged and penalised.
* **Suction:** much weaker while the forceps occupy the working channel, as on a real scope.
* **Biopsy task:** Settings → Task → *Navigation + biopsies* requires 2 samples each from the gastric body, antrum and duodenum, plus the navigation milestones, in any order. Scoring becomes time 25, contacts 30, insufflation 10, biopsies 25 (quality-weighted), and retroflexion 10. Change the required numbers in `BIOPSY_TARGETS` in `js/sim/Training.js`. Real biopsy protocols usually take more samples per region than this.

## Light / video processor

Settings → *Video processor*: **Light source** 25–300% (or **+ / −** keys) and **Auto-exposure**. Auto-exposure darkens the image as the lens nears the mucosa, like a real processor. Turn it off for a constant exposure.

## Orientation

* **Compass** (top-right of the image, **O** to toggle): where the patient's **D**orsal/**V**entral, **L**eft/**R**ight and **Cr**anial/**Cd** (caudal) lie in the picture right now. Faded letters point along the view axis, and the text underneath says which way you're looking. The blue dashed drop points to the dependent side for the chosen patient position (left lateral recumbency by default), which is where fluid pools.
* **Image orientation reference** (Settings → Orientation): by default the scope is rolled at insertion so that, entering the stomach with neutral knobs and no torque, the **lesser curvature is at 12 o'clock** and the greater curvature at 6. This is computed automatically for any anatomy, including a CT mesh. Alternative: "dorsal at 12 o'clock in the esophagus". **Roll trim** rotates the whole thing in 15° steps if your instructor or scope shows it differently.
* **Label lesser / greater curvature** (Settings, off by default): marks both curvatures on the image rim while you're in the stomach. Useful while learning, so turn it off to test yourself.
* Torque convention: turning the handle **clockwise** (as seen from above / from the operator) rolls the scope clockwise, so the image rotates counter-clockwise.

---

## How the code is organised

```
index.html, phone.html          the two pages
js/common/protocol.js           message contract phone <-> sim, limits
js/common/transport.js          PeerJS (WebRTC), Ably relay and local BroadcastChannel transports
js/phone/controller.js          phone control-section UI, gyro torque, valves, haptics
js/sim/main.js                  wiring + HUD
js/sim/input/InputManager.js    merges all input sources into one control frame
js/sim/input/PhoneSource.js     phone over the transport
js/sim/input/KeyboardMouseSource.js
js/sim/input/GamepadSource.js   USB gamepad / custom hardware (see below)
js/sim/anatomy/proceduralCanineUGI.js   generates the anatomy
js/sim/anatomy/LumenModel.js    mesh + centerline -> frames, radius table, inflation (mesh-agnostic)
js/sim/anatomy/AnatomyIO.js     glTF load/export (+ sidecar metadata)
js/sim/Scope.js                 insertion tube / bending section kinematics, contact, pylorus
js/sim/Renderer.js              Three.js view, fisheye post-process, red-out, scope guide
js/sim/Training.js              milestones and scoring
models/canine_ugi.glb/.json     the procedural anatomy exported as glTF (example for swapping)
vendor/                         three.js r187, PeerJS 1.5.5, Ably JS 2.30, qrcode-generator
```

The simulator only ever sees a **control frame** (`ud`, `lr`, `torque`, `insert`, `air`, `water`, `suction`) from the `InputManager`. Any number of sources can feed it, so new controllers don't touch the sim.

### Replacing the phone with hardware (Arduino Leonardo/Micro or Pi Pico as a USB gamepad)

Make the board enumerate as a HID gamepad (Arduino `Joystick` library, or CircuitPython/TinyUSB on the Pico) and map:

| Gamepad | Meaning |
|---|---|
| axis 0 | up/down knob: −1 full down … 0 neutral … +1 full up |
| axis 1 | right/left knob: −1 full left … +1 full right |
| axis 2 | torque: −1…+1 = −180°…+180° (pot or IMU) |
| axis 3 | insertion encoder position (wraps; only the change is used; full range = 40 cm) |
| button 0 / 1 / 2 | air / water / suction |
| button 3 | straighten |
| button 4 / 5 | insert-withdraw forceps / jaws (hold = open) |
| axis 4 | forceps extension (−1 retracted … +1 fully out) |

It's picked up automatically by `GamepadSource.js` (press any button once so the browser exposes it). Edit `MAP` there if your wiring differs. Only axes that move are applied, so it can coexist with the phone.

### Swapping in a CT-derived anatomy

1. Segment the lumen (esophagus → duodenum) from the CT (e.g. 3D Slicer), export the **mucosal surface** as a mesh, and extract its **centerline** (Slicer *Extract Centerline* / VMTK).
2. Convert the mesh to `.glb` (Blender: File → Export → glTF Binary).
3. Write a sidecar `.json` with the same name — copy `models/canine_ugi.json` as a template:

```json
{
  "format": "k9scope-anatomy@1",
  "units": "mm",
  "axes": { "dorsal": [0, 1, 0], "left": [1, 0, 0], "cranial": [0, 0, 1] },
  "centerline": [[x, y, z], ...],
  "landmarks": { "cardia": [x,y,z], "pylorus": [x,y,z], "target": [x,y,z], "les": [x,y,z], "retroflexTarget": [x,y,z] },
  "regions": [
    { "name": "Esophagus", "from": 0, "to": 280, "insufflation": 0.3 },
    { "name": "Stomach - body", "from": 280, "to": 520, "insufflation": 1.0 },
    { "name": "Pylorus", "from": 520, "to": 540, "insufflation": 0 },
    { "name": "Duodenum", "from": 540, "to": 800, "insufflation": 0.25 }
  ]
}
```

`axes` gives the patient's dorsal, left and cranial directions in the mesh's coordinates. It drives the orientation compass and patient position, so check it against the CT. In DICOM patient (LPS) coordinates for a dog scanned in sternal recumbency, head first, that is usually dorsal = [0,-1,0], left = [1,0,0], cranial = [0,0,1]. Verify with a known landmark, though, because positioning varies. Landmarks can be arc-length distances along the centerline or 3D points (they're projected onto it). Region `from`/`to` are arc lengths in the file's units. `insufflation` sets how much that region distends with air (0 = rigid, 1 = stomach).

4. Load it with **Settings → Load model…** (select both files), or host them in `models/` and open `index.html?model=models/yourdog.glb`.

Wall contact, red-out and insufflation all come from the centerline + a radius table computed from the mesh at load time, so no code changes are needed. The mesh should be a reasonably closed tube; caps at either end are fine.

---

## Notes and limitations (v0.1)

* **Pairing** uses the free PeerJS broker only to introduce the devices; control data then flows directly phone → laptop over WebRTC (unreliable/unordered channel for lowest latency). Latency is shown on both screens. Restrictive campus Wi-Fi can block direct connections — PeerJS then falls back to a relay, or try a phone hotspot.
* iPhone: Safari asks for motion permission on *Tap to start*; haptics are Android-only (iPhone fails silently, as requested).
* The insertion tube follows the lumen centerline with a stiffness offset toward the outer curve; there's no full rod physics, looping or paradoxical motion yet.
* Anatomy is procedural and approximate (a ~20 kg dog). Not validated against clinical measurements.
* Good next steps: gastric looping along the greater curvature, fluid pools to suction, more task types (biopsy target, foreign-body retrieval), recording/replay for instructor review.
