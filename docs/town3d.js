// town3d.js: Derek's open 3D brick world (three.js from a free CDN, nothing to install).
// The town grows outward in blocks of 4 lots, with roads between them, on an island with a beach,
// the sea, and Thai limestone islands on the horizon. Derek walks the roads; his puppy follows him.
//
//   mount(el, {full, minimap})   start it in an element (full = big world page with explore controls)
//   update(state, town)          feed it the latest data (call every refresh)
//   follow()                     camera back on Derek        explore(dx, dz) nudge the explore camera
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const BLOCK = 8.6, ROAD = 3.0, P = BLOCK + ROAD;     // block plate, road width, block pitch
const SLOT = 2.15;                                    // lot centre offset inside a block
const Y_ROAD = 0.04, Y_BLOCK = 0.2, SAND_Y = -0.15, WATER_Y = -0.55;
let beach = null, waves = [], bubble = null;
const WANT_EMOJI = { food: "🦴", play: "🎾", walk: "🐾", beach: "🏖️", cuddle: "❤️", nap: "💤", explore: "👃" }, bubbleMats = new Map();
function bubbleMat(e) {   // kept for the whole visit (not cleared on rebuild)
  if (!bubbleMats.has(e)) {
    const c = document.createElement("canvas"); c.width = c.height = 96; const g = c.getContext("2d");
    g.fillStyle = "rgba(255,255,255,.95)"; g.beginPath(); g.arc(48, 44, 38, 0, 7); g.fill();
    g.beginPath(); g.moveTo(36, 76); g.lineTo(44, 94); g.lineTo(54, 78); g.fill();
    g.font = "44px 'Segoe UI Emoji','Apple Color Emoji',sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(e, 48, 46);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    bubbleMats.set(e, new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  }
  return bubbleMats.get(e);
}

let R, scene, cam, controls, root, studMesh, jar, pup, pupZ, zzz, bang, sun, hemi, clock, opts;
let lastKey = "", ready = false, night = false, places = {}, homeDoor = new THREE.Vector3(), homeTop = { cx: 0, cz: 0 }, bounds = null;
let mode = "follow", lastState = null, mini = null, miniT = 0, clouds = [];
const keys = new Set(), push = new THREE.Vector2();
const mats = new Map(), geos = new Map();
let disposables = [], studs = [], blocks = [];

// ------------------------------------------------------------------ helpers
function mat(color, extra = {}) {
  const key = color + JSON.stringify(extra);
  if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0, ...extra }));
  return mats.get(key);
}
const geo = (key, make) => { if (!geos.has(key)) geos.set(key, make()); return geos.get(key); };
const box = (w, h, d) => geo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cyl = (rt, rb, h, s = 16) => geo(`c${rt},${rb},${h},${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s));
const sph = (r, s = 16) => geo(`s${r},${s}`, () => new THREE.SphereGeometry(r, s, Math.max(6, s * 0.7 | 0)));
const cone = (r, h, s = 12) => geo(`k${r},${h},${s}`, () => new THREE.ConeGeometry(r, h, s));
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; };
const rnd = (s) => (hash(s) % 10000) / 10000;
const shade = (hex, f) => { const c = new THREE.Color(hex); return "#" + (f < 0 ? c.multiplyScalar(1 + f) : c.lerp(new THREE.Color("#fff"), f)).getHexString(); };

function add(parent, g, m, x, y, z, rx = 0, ry = 0, rz = 0, shadow = true) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z); o.rotation.set(rx, ry, rz);
  o.castShadow = shadow; o.receiveShadow = true;
  parent.add(o);
  return o;
}
const _v = new THREE.Vector3();
function studsOn(parent, x0, z0, w, d, y, color, step = 0.5) {
  parent.updateMatrixWorld(true);
  for (let x = x0 - w / 2 + step / 2; x < x0 + w / 2; x += step)
    for (let z = z0 - d / 2 + step / 2; z < z0 + d / 2; z += step) {
      _v.set(x, y, z).applyMatrix4(parent.matrixWorld);
      studs.push([_v.x, _v.y, _v.z, color]);
    }
}
function brick(parent, w, h, d, color, x, y, z, withStuds = true) {
  const o = add(parent, box(w, h, d), mat(color), x, y + h / 2, z);
  if (withStuds) studsOn(parent, x, z, w, d, y + h, color);
  return o;
}
function canvasTex(w, h, draw) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  disposables.push(t);
  return t;
}
function label(text, size = 0.5, { stroke = "#3a1a08", color = "#fff" } = {}) {
  const font = "bold 46px system-ui, 'Segoe UI', 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif";
  const probe = document.createElement("canvas").getContext("2d"); probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + 28;
  const t = canvasTex(w, 64, (g) => {
    g.font = font; g.textAlign = "center"; g.textBaseline = "middle";
    if (stroke) { g.lineWidth = 9; g.strokeStyle = stroke; g.lineJoin = "round"; g.strokeText(text, w / 2, 35); }
    g.fillStyle = color; g.fillText(text, w / 2, 35);
  });
  const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false });
  disposables.push(m);
  const s = new THREE.Sprite(m);
  s.scale.set(size * w / 64, size, 1);
  return s;
}
const stripes = (a, b) => canvasTex(128, 32, (g) => { for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? b : a; g.fillRect(i * 16, 0, 16, 32); } });
const winMat = () => night ? mat("#ffd86b", { emissive: "#ffb000", emissiveIntensity: 0.9 }) : mat("#bfe3ff", { roughness: 0.15 });

// ------------------------------------------------------------------ layout: lots -> blocks -> spiral
function spiral(n) {
  const out = [[0, 0]];
  let x = 0, z = 0, dx = 1, dz = 0, seg = 1, step = 0, turns = 0;
  while (out.length < n) {
    x += dx; z += dz; out.push([x, z]);
    if (++step === seg) { step = 0; [dx, dz] = [-dz, dx]; if (++turns % 2 === 0) seg++; }
  }
  return out;
}
function lotSpot(n) {
  const [bx, bz] = blocks[n >> 2], s = n & 3;
  const sx = s & 1 ? 1 : -1, sz = s & 2 ? 1 : -1;            // slots 0,1 face north (-z); 2,3 face south (+z)
  const cx = bx * P + sx * SLOT, cz = bz * P + sz * SLOT;
  return { cx, cz, face: sz > 0 ? 0 : Math.PI, door: new THREE.Vector3(cx + 0.8 * sz, Y_ROAD, bz * P + sz * (BLOCK / 2 + 0.6)) };
}
const roadLine = (v) => (Math.round(v / P - 0.5) + 0.5) * P;   // nearest road centre line

function pathTo(from, to) {
  const zA = roadLine(from.z), zB = roadLine(to.z), xr = roadLine((from.x + to.x) / 2);
  const pts = [new THREE.Vector3(from.x, Y_ROAD, zA), new THREE.Vector3(xr, Y_ROAD, zA),
               new THREE.Vector3(xr, Y_ROAD, zB), new THREE.Vector3(to.x, Y_ROAD, zB), to.clone()];
  const out = [];
  let prev = from;
  for (const p of pts) { if (p.distanceTo(prev) > 0.05) out.push(p); prev = p; }
  return out;
}

// ------------------------------------------------------------------ buildings (same brick style as before)
function tree(g, x, z, seed, s = 1) {
  s *= 0.85 + (seed % 5) / 12;
  add(g, cyl(0.14, 0.18, 0.9 * s), mat("#7a4a22"), x, 0.45 * s, z);
  add(g, cone(0.85 * s, 1.2 * s), mat("#2e8b3d"), x, 1.35 * s, z);
  add(g, cone(0.6 * s, 0.9 * s), mat("#3fae4f"), x, 1.95 * s, z);
}
function palm(g, x, z, seed) {
  const lean = (rnd(seed + "l") - 0.5) * 0.5;
  for (let i = 0; i < 6; i++) add(g, cyl(0.16 - i * 0.01, 0.18 - i * 0.01, 0.6, 8), mat("#8b6a3e"), x + lean * i * 0.25, -0.15 + 0.3 + i * 0.58, z);
  const tx = x + lean * 1.5, ty = 3.45;
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + (seed % 3);
    add(g, box(1.8, 0.06, 0.45), mat("#2e9b4f"), tx + Math.cos(a) * 0.8, ty - 0.25, z + Math.sin(a) * 0.8, 0, -a, -0.35); }
  add(g, sph(0.18, 8), mat("#6b4423"), tx, ty - 0.2, z);
}
function lamp(g, x, z, s = 1) {
  add(g, cyl(0.06, 0.08, 2.2 * s), mat("#3b3f46"), x, 1.1 * s, z);
  add(g, box(0.45, 0.14, 0.45), mat("#3b3f46"), x, 2.27 * s, z);
  add(g, sph(0.14, 10), night ? mat("#fff3b0", { emissive: "#ffd34d", emissiveIntensity: 1.6 }) : mat("#dddddd"), x, 2.1 * s, z, 0, 0, 0, false);
}

function building(l) {
  const spot = lotSpot(l.lot);
  const g = new THREE.Group(); g.position.set(spot.cx, Y_BLOCK, spot.cz); g.rotation.y = spot.face; root.add(g);
  const look = l.look || {}, kind = look.kind || "shop", c = look.color || "#8e44ad";
  const f = Math.max(1, Math.min(4, look.floors || 1));
  const sign = (y) => { if (look.emoji) { const s = label(look.emoji, 0.95, { stroke: null }); s.position.set(0, y, 0.2); g.add(s); } };
  switch (kind) {
    case "house": {
      const h = 1.25 * f + 0.35;
      brick(g, 3, h, 2.6, c, 0, 0, 0, false);
      add(g, cone(2.2, 1.3, 4), mat(look.roof || shade(c, -0.4)), 0, h + 0.65, 0, 0, Math.PI / 4);
      add(g, box(0.7, 1.0, 0.1), mat("#5a3b22"), 0, 0.5, 1.31);
      for (let i = 0; i < f; i++) for (const x of [-0.95, 0.95]) add(g, box(0.6, 0.55, 0.08), winMat(), x, 0.8 + 1.25 * i, 1.31);
      sign(h + 1.9); break;
    }
    case "garage": {
      brick(g, 3.2, 1.9, 2.6, c, 0, 0, 0);
      const dm = new THREE.MeshStandardMaterial({ map: canvasTex(64, 64, (x) => {
        x.fillStyle = "#c3c8cf"; x.fillRect(0, 0, 64, 64); x.fillStyle = "#8a9099"; for (let y = 6; y < 64; y += 9) x.fillRect(0, y, 64, 2); }) });
      disposables.push(dm);
      add(g, box(1.9, 1.35, 0.08), dm, -0.45, 0.68, 1.31);
      add(g, box(0.6, 1.0, 0.08), mat("#3b3f46"), 1.05, 0.5, 1.31);
      sign(2.6); break;
    }
    case "tower": {
      const h = 1.1 * f + 1.2;
      brick(g, 1.6, h, 1.6, c, 0, 0, 0);
      for (let y = 1.3; y < h - 0.3; y += 1.0) add(g, box(0.45, 0.5, 0.08), winMat(), 0, y, 0.81);
      add(g, box(0.55, 0.9, 0.08), mat("#5a3b22"), 0, 0.45, 0.81);
      add(g, cyl(0.04, 0.04, 1.3), mat("#333"), 0, h + 0.75, 0);
      add(g, box(0.6, 0.35, 0.04), mat("#e8762b"), 0.32, h + 1.2, 0);
      sign(h + 1.9); break;
    }
    case "pit": {
      const cols = ["#d0453a", "#f2c230", "#2f6fb3", "#3f9b5a"];
      [4, 3, 2, 1].forEach((n, row) => { for (let i = 0; i < n; i++)
        brick(g, 0.5, 0.36, 1.0, cols[(i + row) % 4], -n * 0.27 + i * 0.54 + 0.27, row * 0.36, (row % 2) * 0.2); });
      const face = canvasTex(64, 64, (x) => { x.fillStyle = "#f5b81b"; x.fillRect(0, 0, 64, 64); x.strokeStyle = "#7a4f00"; x.lineWidth = 6; x.strokeRect(3, 3, 58, 58);
        x.fillStyle = "#fff"; x.font = "900 44px system-ui"; x.textAlign = "center"; x.textBaseline = "middle"; x.lineWidth = 4; x.strokeText("!", 32, 34); x.fillText("!", 32, 34); });
      bang = add(g, box(0.8, 0.8, 0.8), new THREE.MeshStandardMaterial({ map: face, roughness: 0.5 }), 0, 2.9, 0.4);
      disposables.push(bang.material);
      break;
    }
    case "park":
      brick(g, 3.4, 0.12, 2.8, "#3fae4f", 0, 0, 0);
      tree(g, 0.8, -0.3, hash(l.id));
      add(g, box(1.4, 0.1, 0.45), mat("#8b5a2b"), -0.6, 0.5, 0.7);
      add(g, box(1.4, 0.4, 0.08), mat("#8b5a2b"), -0.6, 0.75, 0.5);
      for (const x of [-1.2, 0]) add(g, box(0.1, 0.45, 0.4), mat("#5a3b22"), x, 0.25, 0.7);
      break;
    case "track": {
      for (const [x, r] of [[-1.1, 0.55], [0.1, 0.4], [1.1, 0.6]]) add(g, cyl(r, r, 2.4, 20), mat("#8d6e63"), x, 0, 0, Math.PI / 2);
      add(g, cyl(0.04, 0.04, 2.2), mat("#333"), 1.6, 1.1, 1.0);
      const fm = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, map: canvasTex(32, 32, (x) => {
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { x.fillStyle = (i + j) % 2 ? "#111" : "#fff"; x.fillRect(i * 8, j * 8, 8, 8); } }) });
      disposables.push(fm);
      const pl = new THREE.PlaneGeometry(0.7, 0.5); disposables.push(pl);
      add(g, pl, fm, 1.95, 1.95, 1.0);
      sign(2.6); break;
    }
    case "tree": tree(g, 0, 0, hash(l.id)); break;
    case "lamp": lamp(g, 0, 0.9, 1); break;
    case "flowers": {
      brick(g, 2.4, 0.25, 1.0, "#6b4423", 0, 0, 0.6, false);
      const fc = ["#e74c3c", "#f1c40f", "#9b59b6", "#ffffff", "#e67e22"];
      for (let i = 0; i < 6; i++) {
        const x = -1 + i * 0.4;
        add(g, cyl(0.025, 0.025, 0.4, 6), mat("#2e8b3d"), x, 0.45, 0.6);
        add(g, sph(0.11, 10), mat(fc[(i + hash(l.id)) % 5]), x, 0.68, 0.6);
      }
      break;
    }
    case "fountain":
      add(g, cyl(1.3, 1.4, 0.45, 28), mat("#9aa5b1"), 0, 0.22, 0.3);
      add(g, cyl(1.12, 1.12, 0.47, 28), mat("#5dade2", { roughness: 0.1 }), 0, 0.24, 0.3);
      add(g, cyl(0.14, 0.18, 1.0), mat("#9aa5b1"), 0, 0.9, 0.3);
      add(g, cyl(0.55, 0.3, 0.18, 20), mat("#9aa5b1"), 0, 1.45, 0.3);
      add(g, cyl(0.05, 0.35, 0.7, 14), mat("#8fd3ff", { transparent: true, opacity: 0.6 }), 0, 1.85, 0.3);
      break;
    case "stall": {
      add(g, box(2.4, 0.8, 1.0), mat("#a0522d"), 0, 0.4, 0.6);
      for (const [x, z] of [[-1.25, 0.15], [1.25, 0.15], [-1.25, 1.1], [1.25, 1.1]]) add(g, cyl(0.05, 0.05, 2.0, 8), mat("#ddd"), x, 1.0, z);
      const cm = new THREE.MeshStandardMaterial({ map: stripes(c, "#ffffff") }); disposables.push(cm);
      add(g, box(2.9, 0.12, 1.5), cm, 0, 2.05, 0.6, 0.12);
      for (let i = 0; i < 4; i++) brick(g, 0.35, 0.25, 0.35, ["#f2c230", "#d0453a", "#3f9b5a", "#e8762b"][i], -0.9 + i * 0.6, 0.8, 0.6);
      sign(2.8); break;
    }
    default: {   // "shop" and his own designs
      const h = 1.6 + 1.1 * (f - 1);
      brick(g, 3, h, 2.6, c, 0, 0, 0);
      for (let i = 1; i < f; i++) for (const x of [-0.95, 0.95]) add(g, box(0.6, 0.55, 0.08), winMat(), x, 1.6 + 1.1 * (i - 1) + 0.4, 1.31);
      const am = new THREE.MeshStandardMaterial({ map: stripes(shade(c, -0.25), "#ffffff") }); disposables.push(am);
      add(g, box(3.2, 0.1, 0.9), am, 0, 1.35, 1.65, 0.35);
      add(g, box(1.1, 0.7, 0.08), winMat(), -0.6, 0.6, 1.31);
      add(g, box(0.6, 1.0, 0.08), mat("#5a3b22"), 0.9, 0.5, 1.31);
      sign(h + 0.9);
    }
  }
  if (!/^(tree|lamp|flowers)$/.test(kind)) { const t = label(l.name, 0.4); t.position.set(0, 0.5, 2.1); g.add(t); }
  return spot;
}
function site(s) {
  const spot = lotSpot(s.lot);
  const g = new THREE.Group(); g.position.set(spot.cx, Y_BLOCK, spot.cz); g.rotation.y = spot.face; root.add(g);
  const c = (s.look && s.look.color) || "#9aa5b1", frac = Math.max(0.08, s.done / s.work);
  add(g, box(2.8, 2.4 * frac, 2.4), mat(c, { transparent: true, opacity: 0.75 }), 0, 1.2 * frac, 0);
  const pole = mat("#d4892a");
  for (const x of [-1.5, 1.5]) for (const z of [-1.3, 1.3]) add(g, box(0.1, 2.8, 0.1), pole, x, 1.4, z);
  for (const y of [0.9, 1.8, 2.7]) for (const z of [-1.3, 1.3]) add(g, box(3.1, 0.08, 0.08), pole, 0, y, z);
  const t = label(`🚧 ${s.name} ${s.done}/${s.work}`, 0.5); t.position.set(0, 3.4, 0); g.add(t);
  return spot;
}

function groundY(x, z) {
  if (!bounds) return Y_ROAD;
  const i = bounds.isle, dx = Math.abs(x - bounds.cx), dz = Math.abs(z - bounds.cz);
  if (dx <= i.w / 2 && dz <= i.d / 2) return Y_ROAD;
  if (dx <= i.w / 2 + 5 && dz <= i.d / 2 + 5) return SAND_Y;
  return WATER_Y;
}
function castle(g, x, z, n) {
  const sand = mat("#e6c27a");
  if (n >= 5) add(g, cyl(1.35, 1.35, 0.04, 28), mat("#5dade2", { roughness: 0.1 }), x, SAND_Y + 0.01, z, 0, 0, 0, false);
  for (let i = 0; i < Math.min(n, 3); i++) { const w = 1.4 - i * 0.35; add(g, box(w, 0.3, w), sand, x, SAND_Y + 0.15 + i * 0.3, z); }
  if (n >= 4) for (const [dx, dz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) {
    add(g, cyl(0.16, 0.18, 0.7, 10), sand, x + dx, SAND_Y + 0.35, z + dz);
    add(g, cone(0.21, 0.25, 10), sand, x + dx, SAND_Y + 0.82, z + dz);
  }
  if (n >= 6) { add(g, cyl(0.02, 0.02, 0.7, 6), mat("#333"), x, SAND_Y + 1.2, z); add(g, box(0.3, 0.18, 0.02), mat("#d0453a"), x + 0.15, SAND_Y + 1.45, z); }
}

// ------------------------------------------------------------------ Derek + his puppy
function makeDerek() {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: "#e9c39b", roughness: 0.42 });   // his own: it tans
  const blue = mat("#2f6fb3"), dark = mat("#3b3f46"), boot = mat("#5a3b22"), cap = mat("#e8762b"), ink = mat("#222");
  for (const x of [-0.16, 0.16]) { add(g, box(0.28, 0.55, 0.32), dark, x, 0.43, 0); add(g, box(0.3, 0.16, 0.42), boot, x, 0.08, 0.04); }
  add(g, box(0.64, 0.14, 0.34), dark, 0, 0.76, 0);
  add(g, box(0.68, 0.62, 0.36), blue, 0, 1.13, 0);
  add(g, box(0.3, 0.2, 0.02), mat("#24598f"), 0, 1.15, 0.19);
  for (const s of [-1, 1]) { add(g, box(0.17, 0.52, 0.22), blue, s * 0.43, 1.12, 0, 0, 0, s * 0.12); add(g, cyl(0.08, 0.08, 0.14, 10), skin, s * 0.47, 0.8, 0.02); }
  add(g, cyl(0.1, 0.1, 0.08), skin, 0, 1.48, 0);
  add(g, cyl(0.24, 0.24, 0.42, 22), skin, 0, 1.72, 0);
  for (const x of [-0.08, 0.08]) add(g, sph(0.035, 8), ink, x, 1.76, 0.23);
  add(g, box(0.14, 0.025, 0.02), ink, 0, 1.63, 0.24);
  add(g, cyl(0.26, 0.26, 0.15, 22), cap, 0, 1.99, 0);
  add(g, box(0.32, 0.04, 0.24), cap, 0, 1.94, 0.3);
  const board = add(g, box(0.6, 0.1, 2.2), mat("#f6b24a"), 0, -0.04, 0.1); board.visible = false;
  g.userData.skin = skin; g.userData.board = board;
  g.scale.setScalar(0.62);
  return g;
}
function makePup() {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const fur = mat("#c58b52"), dark = mat("#7a4e2a"), ink = mat("#1d1d1d"), pink = mat("#e98a8a");
  add(body, box(0.5, 0.26, 0.26), fur, 0, 0.32, 0);                       // nose points +x
  add(body, box(0.28, 0.26, 0.27), fur, 0.3, 0.5, 0);
  add(body, box(0.15, 0.12, 0.17), dark, 0.47, 0.44, 0);
  add(body, sph(0.035, 8), ink, 0.55, 0.47, 0);
  for (const z of [-0.07, 0.07]) add(body, sph(0.028, 8), ink, 0.43, 0.56, z);
  for (const z of [-0.14, 0.14]) add(body, box(0.1, 0.16, 0.05), dark, 0.25, 0.55, z, z > 0 ? 0.35 : -0.35);
  add(body, box(0.06, 0.02, 0.08), pink, 0.52, 0.38, 0);
  for (const x of [-0.17, 0.17]) for (const z of [-0.09, 0.09]) add(body, box(0.08, 0.22, 0.08), fur, x, 0.11, z);
  const tail = new THREE.Group(); tail.position.set(-0.25, 0.42, 0); body.add(tail);
  add(tail, box(0.2, 0.05, 0.05), dark, -0.09, 0.05, 0, 0, 0, 0.6);
  g.userData = { tail, body };
  g.scale.setScalar(0.9);
  return g;
}

// ------------------------------------------------------------------ the world
function rebuild(town, luckyLive) {
  if (root) { scene.remove(root); for (const d of disposables) d.dispose(); }
  disposables = []; studs = []; clouds = []; bang = null;
  root = new THREE.Group(); scene.add(root);
  const site0 = town.site;
  const nLots = Math.max(town.max_lots, site0 ? site0.lot + 1 : 0, ...town.lots.map((l) => l.lot + 1));
  blocks = spiral(Math.ceil(nLots / 4) + 1);
  const used = blocks.slice(0, Math.ceil(nLots / 4));
  const bxs = used.map((b) => b[0]), bzs = used.map((b) => b[1]);
  bounds = { x0: (Math.min(...bxs) - 0.5) * P, x1: (Math.max(...bxs) + 0.5) * P, z0: (Math.min(...bzs) - 0.5) * P, z1: (Math.max(...bzs) + 0.5) * P };
  const cx = (bounds.x0 + bounds.x1) / 2, cz = (bounds.z0 + bounds.z1) / 2;
  const isle = { w: bounds.x1 - bounds.x0 + 34, d: bounds.z1 - bounds.z0 + 34 };
  Object.assign(bounds, { isle, cx, cz });

  // sea, beach, island (grass top + Mario brick sides)
  const seaGeo = new THREE.PlaneGeometry(900, 900); disposables.push(seaGeo);
  add(root, seaGeo, mat("#2f8fd0", { roughness: 0.2, metalness: 0.1 }), cx, -0.55, cz, -Math.PI / 2, 0, 0, false);
  add(root, box(isle.w + 10, 0.6, isle.d + 10), mat("#f2d28b", { roughness: 0.9 }), cx, -0.45, cz, 0, 0, 0, false);
  // the beach (south shore): towel + umbrella, his board, today's sand castle, waves
  const bzz = cz + isle.d / 2 + 2.6, V = (x, y, z) => new THREE.Vector3(x, y, z);
  beach = { spot: V(cx, SAND_Y, bzz), towel: V(cx - 2.4, SAND_Y, bzz + 0.3), castle: V(cx + 2.6, SAND_Y, bzz - 0.4),
            swim: V(cx + 0.6, WATER_Y, bzz + 5), surf: V(cx - 1.2, WATER_Y, bzz + 9), edge: bzz + 2.1,
            gate: V(roadLine(cx), Y_ROAD, bounds.z1) };
  const tm = new THREE.MeshStandardMaterial({ map: stripes("#e8762b", "#ffffff") }); disposables.push(tm);
  add(root, box(1.0, 0.03, 2.0), tm, beach.towel.x, SAND_Y + 0.02, beach.towel.z, 0, 0, 0, false);
  add(root, cyl(0.04, 0.04, 2.0, 8), mat("#dddddd"), beach.towel.x + 0.9, SAND_Y + 1.0, beach.towel.z - 0.6);
  add(root, cone(1.3, 0.5, 12), mat("#d0453a"), beach.towel.x + 0.9, SAND_Y + 2.1, beach.towel.z - 0.6);
  const st = lastState && lastState.state;
  if (st && (st.owned || []).includes("surfboard")) add(root, box(0.5, 1.9, 0.09), mat("#f6b24a"), cx - 3.8, SAND_Y + 0.85, bzz - 0.3, 0, 0, 0.15);
  for (const c of ((st && st.beach && st.beach.castles) || []).slice(-1)) castle(root, beach.castle.x, beach.castle.z, c.size);
  waves = [];
  for (let i = 0; i < 3; i++) {
    const w = add(root, box(isle.w + 10, 0.04, 0.35), mat("#ffffff", { transparent: true, opacity: 0.7 }), cx, WATER_Y + 0.05, bzz + 3 + i * 2.2, 0, 0, 0, false);
    w.userData.z0 = w.position.z; waves.push(w);
  }
  const brickTex = canvasTex(128, 64, (g) => {
    g.fillStyle = "#c4622d"; g.fillRect(0, 0, 128, 64); g.strokeStyle = "#7d3514"; g.lineWidth = 3;
    for (let y = 0; y <= 64; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke(); }
    for (let r = 0; r < 4; r++) for (let x = (r % 2) * 16; x < 128; x += 32) { g.beginPath(); g.moveTo(x, r * 16); g.lineTo(x, r * 16 + 16); g.stroke(); }
  });
  brickTex.wrapS = brickTex.wrapT = THREE.RepeatWrapping; brickTex.repeat.set(isle.w / 2, 0.4);
  const side = new THREE.MeshStandardMaterial({ map: brickTex, roughness: 0.8 }); disposables.push(side);
  const groundGeo = new THREE.BoxGeometry(isle.w, 0.5, isle.d); disposables.push(groundGeo);
  const ground = new THREE.Mesh(groundGeo, [side, side, mat("#47b350"), side, side, side]);
  ground.position.set(cx, -0.25, cz); ground.receiveShadow = true; root.add(ground);
  studsOn(root, cx, cz, isle.w, isle.d, 0, "#47b350", 1.0);

  // roads (dashed centre lines line up with the block grid) + blocks
  const rw = bounds.x1 - bounds.x0 + ROAD, rd = bounds.z1 - bounds.z0 + ROAD;
  const roadTex = canvasTex(128, 128, (g) => {
    g.fillStyle = "#5b5f66"; g.fillRect(0, 0, 128, 128); g.fillStyle = "#f4f1e8";
    for (let i = 4; i < 128; i += 24) { g.fillRect(i, 0, 12, 2); g.fillRect(i, 126, 12, 2); g.fillRect(0, i, 2, 12); g.fillRect(126, i, 2, 12); }
  });
  roadTex.wrapS = roadTex.wrapT = THREE.RepeatWrapping; roadTex.repeat.set(rw / P, rd / P);
  roadTex.offset.set(((-ROAD / 2) / P) % 1, ((-ROAD / 2) / P) % 1);
  const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.9 }); disposables.push(roadMat);
  add(root, box(rw, 0.08, rd), roadMat, cx, 0, cz, 0, 0, 0, false);
  for (const [bx, bz] of used) {
    add(root, box(BLOCK, Y_BLOCK, BLOCK), mat("#c9c4b8"), bx * P, Y_BLOCK / 2, bz * P, 0, 0, 0, false);
    studsOn(root, bx * P, bz * P, BLOCK, BLOCK, Y_BLOCK, "#c9c4b8");
  }
  // street lamps at the crossings
  const crossings = new Set();
  for (const [a, b] of used) for (const sx of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) crossings.add(`${(a + sx) * P},${(b + sz) * P}`);
  for (const k of crossings) { const [x, z] = k.split(",").map(Number); lamp(root, x + ROAD / 2 - 0.2, z + ROAD / 2 - 0.2, 1.1); }

  // the lots
  places = {};
  for (const l of town.lots) { const s = building(l); if (l.place) places[l.place] = s.door; }
  if (site0) places.building_site = site(site0).door;
  for (let n = 0; n < town.max_lots; n++) {       // empty lots: a little "for sale" sign
    if (town.lots.some((l) => l.lot === n) || (site0 && site0.lot === n)) continue;
    const s = lotSpot(n), g = new THREE.Group(); g.position.set(s.cx, Y_BLOCK, s.cz); g.rotation.y = s.face; root.add(g);
    add(g, box(0.06, 0.8, 0.06), mat("#8b5a2b"), 0, 0.4, 1.0);
    add(g, box(0.7, 0.4, 0.05), mat("#ffffff"), 0, 0.9, 1.0);
  }
  homeDoor.copy(places.home || new THREE.Vector3());
  places.beach = beach.spot;
  const hl = town.lots.find((l) => l.place === "home"); if (hl) homeTop = lotSpot(hl.lot);

  // open countryside: trees, bushes, rocks, flowers around the town; palms on the beach
  const inTown = (x, z) => x > bounds.x0 - 2 && x < bounds.x1 + 2 && z > bounds.z0 - 2 && z < bounds.z1 + 2;
  const nat = new THREE.Group(); root.add(nat);
  const count = Math.round(isle.w * isle.d / 22);
  for (let i = 0; i < count; i++) {
    const x = cx + (rnd("x" + i) - 0.5) * (isle.w - 3), z = cz + (rnd("z" + i) - 0.5) * (isle.d - 3);
    if (inTown(x, z)) continue;
    const t = rnd("t" + i);
    if (t < 0.45) tree(nat, x, z, hash("s" + i), 1.1);
    else if (t < 0.65) add(nat, sph(0.5 + rnd("r" + i) * 0.4, 10), mat("#2f9a45"), x, 0.25, z);
    else if (t < 0.8) add(nat, box(0.9, 0.6, 0.7), mat("#9aa0a6"), x, 0.3, z, 0, rnd("a" + i) * 3);
    else for (let k = 0; k < 3; k++) add(nat, sph(0.12, 8), mat(["#e74c3c", "#f1c40f", "#ffffff"][k]), x + k * 0.3, 0.15, z + (k % 2) * 0.3, 0, 0, 0, false);
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + rnd("pa" + i) * 0.3;
    const hx = isle.w / 2 + 2.5, hz = isle.d / 2 + 2.5, k = 1 / Math.max(Math.abs(Math.cos(a)) / hx, Math.abs(Math.sin(a)) / hz);
    palm(nat, cx + Math.cos(a) * k, cz + Math.sin(a) * k, i);
  }
  // Thai limestone islands on the horizon (the dream)
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.4, dist = 120 + rnd("kd" + i) * 70, h = 18 + rnd("kh" + i) * 22, r = 5 + rnd("kr" + i) * 6;
    const kx = cx + Math.cos(a) * dist, kz = cz + Math.sin(a) * dist;
    add(root, cyl(r * 0.55, r, h, 10), mat("#7d8c74", { roughness: 1 }), kx, h / 2 - 1, kz, 0, 0, 0, false);
    add(root, sph(r * 0.6, 10), mat("#4f7d4a", { roughness: 1 }), kx, h - 1, kz, 0, 0, 0, false);
  }
  // clouds
  for (let i = 0; i < 10; i++) {
    const cl = new THREE.Group(); cl.position.set(cx + (rnd("cx" + i) - 0.5) * 160, 16 + rnd("cy" + i) * 8, cz + (rnd("cz" + i) - 0.5) * 160);
    const cm = mat("#ffffff", { transparent: true, opacity: night ? 0.15 : 0.92 });
    for (const [dx, dy, r] of [[0, 0, 2.2], [2.2, 0.3, 1.8], [-2.2, 0.2, 1.6], [0.8, 1.3, 1.6]]) add(cl, sph(r, 12), cm, dx, dy, 0, 0, 0, 0, false);
    root.add(cl); clouds.push(cl);
  }
  if (night) {
    const pts = []; for (let i = 0; i < 700; i++) { const a = rnd("sa" + i) * Math.PI * 2, e = 0.15 + rnd("se" + i) * 1.3, d = 300;
      pts.push(cx + Math.cos(a) * Math.cos(e) * d, Math.sin(e) * d, cz + Math.sin(a) * Math.cos(e) * d); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const sm = new THREE.PointsMaterial({ color: "#ffffff", size: 1.2, sizeAttenuation: false }); disposables.push(sg, sm);
    root.add(new THREE.Points(sg, sm));
  }
  if (bang && !luckyLive) bang.material.color.set("#8a8a8a");

  // every stud in one instanced mesh
  if (studMesh) { scene.remove(studMesh); studMesh.material.dispose(); studMesh.dispose(); }
  studMesh = new THREE.InstancedMesh(cyl(0.12, 0.12, 0.1, 10), new THREE.MeshStandardMaterial({ roughness: 0.42 }), studs.length);
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  studs.forEach(([x, y, z, c], i) => { m4.makeTranslation(x, y + 0.05, z); studMesh.setMatrixAt(i, m4); studMesh.setColorAt(i, col.set(c)); });
  studMesh.receiveShadow = true;
  scene.add(studMesh);

  scene.background = new THREE.Color(night ? "#0b1433" : "#8fd3ff");
  scene.fog = new THREE.Fog(scene.background, opts.full ? 70 : 45, opts.full ? 260 : 140);
  hemi.intensity = night ? 0.35 : 1.0; hemi.color.set(night ? "#7080c0" : "#ffffff");
  sun.intensity = night ? 0.25 : 2.2; sun.color.set(night ? "#9fb4ff" : "#fff4e0");
}

// ------------------------------------------------------------------ minimap (top-down, north up)
function drawMini() {
  if (!mini || !bounds) return;
  const g = mini.getContext("2d"), W = mini.width, H = mini.height, isle = bounds.isle;
  const s = Math.min(W, H) / (Math.max(isle.w, isle.d) + 16);
  const X = (x) => W / 2 + (x - bounds.cx) * s, Z = (z) => H / 2 + (z - bounds.cz) * s;
  g.fillStyle = night ? "#123a5a" : "#3c9ad6"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#f2d28b"; g.fillRect(X(bounds.cx - isle.w / 2 - 5), Z(bounds.cz - isle.d / 2 - 5), (isle.w + 10) * s, (isle.d + 10) * s);
  g.fillStyle = night ? "#2f6b3a" : "#55b85e"; g.fillRect(X(bounds.cx - isle.w / 2), Z(bounds.cz - isle.d / 2), isle.w * s, isle.d * s);
  g.fillStyle = "#666b73"; g.fillRect(X(bounds.x0 - ROAD / 2), Z(bounds.z0 - ROAD / 2), (bounds.x1 - bounds.x0 + ROAD) * s, (bounds.z1 - bounds.z0 + ROAD) * s);
  const town = lastState ? lastState.town : { lots: [] };
  for (const l of town.lots) {
    const sp = lotSpot(l.lot), look = l.look || {};
    g.fillStyle = look.color || (look.kind === "pit" ? "#f2c230" : "#58b05f");
    g.fillRect(X(sp.cx - 1.6), Z(sp.cz - 1.4), 3.2 * s, 2.8 * s);
  }
  if (town.site) { const sp = lotSpot(town.site.lot); g.strokeStyle = "#ff9b2f"; g.lineWidth = 2; g.strokeRect(X(sp.cx - 1.6), Z(sp.cz - 1.4), 3.2 * s, 2.8 * s); }
  const dot = (v, col, r) => { g.fillStyle = col; g.beginPath(); g.arc(X(v.x), Z(v.z), r, 0, 7); g.fill(); g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.stroke(); };
  if (pup.visible) dot(pup.position, "#b07a4a", 3.5);
  dot(jar.visible ? jar.position : homeDoor, "#e8762b", 5);
  const t = controls.target, dir = new THREE.Vector3(); cam.getWorldDirection(dir);   // where you're looking
  const a = Math.atan2(dir.z, dir.x);
  g.fillStyle = "rgba(255,255,255,.95)"; g.beginPath();
  g.moveTo(X(t.x) + Math.cos(a) * 9, Z(t.z) + Math.sin(a) * 9);
  g.lineTo(X(t.x) + Math.cos(a + 2.5) * 6, Z(t.z) + Math.sin(a + 2.5) * 6);
  g.lineTo(X(t.x) + Math.cos(a - 2.5) * 6, Z(t.z) + Math.sin(a - 2.5) * 6); g.fill();
  mini._toWorld = (px, py) => ({ x: bounds.cx + (px - W / 2) / s, z: bounds.cz + (py - H / 2) / s });
}

// ------------------------------------------------------------------ public API
export function mount(el, options = {}) {
  opts = { full: false, minimap: null, ...options };
  R = new THREE.WebGLRenderer({ antialias: true });
  R.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap;
  el.appendChild(R.domElement);
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(opts.full ? 50 : 40, 2, 0.1, 700);
  hemi = new THREE.HemisphereLight("#ffffff", "#5a7a3a", 1.0); scene.add(hemi);
  sun = new THREE.DirectionalLight("#fff4e0", 2.2);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 80 });
  scene.add(sun, sun.target);
  controls = new OrbitControls(cam, R.domElement);
  Object.assign(controls, { enableDamping: true, enablePan: false, minDistance: opts.full ? 2.5 : 5, maxDistance: opts.full ? 90 : 50,
                            maxPolarAngle: opts.full ? 1.53 : 1.42 });
  cam.position.set(7, 8, 14); controls.target.set(0, 1, 0);
  jar = makeDerek(); scene.add(jar);
  pup = makePup(); pup.visible = false; scene.add(pup);
  zzz = label("Zzz", 0.9); zzz.visible = false; scene.add(zzz);
  pupZ = label("z", 0.5); pupZ.visible = false; scene.add(pupZ);
  bubble = new THREE.Sprite(bubbleMat("🎾")); bubble.scale.set(0.7, 0.7, 1); bubble.visible = false; scene.add(bubble);
  clock = new THREE.Clock();
  const fit = () => { const w = el.clientWidth || 600, h = el.clientHeight || 340; R.setSize(w, h, false);
    R.domElement.style.width = "100%"; R.domElement.style.height = "100%"; cam.aspect = w / h; cam.updateProjectionMatrix(); };
  new ResizeObserver(fit).observe(el); fit();
  if (opts.full) {
    addEventListener("keydown", (e) => { if (/^(w|a|s|d|arrowup|arrowdown|arrowleft|arrowright)$/i.test(e.key)) { keys.add(e.key.toLowerCase()); mode = "explore"; e.preventDefault(); } });
    addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
    addEventListener("blur", () => keys.clear());
    if (opts.minimap) {
      mini = opts.minimap;
      mini.addEventListener("click", (e) => {
        if (!mini._toWorld) return;
        const r = mini.getBoundingClientRect();
        const p = mini._toWorld((e.clientX - r.left) * mini.width / r.width, (e.clientY - r.top) * mini.height / r.height);
        mode = "explore";
        const dx = p.x - controls.target.x, dz = p.z - controls.target.z;
        controls.target.x += dx; controls.target.z += dz; cam.position.x += dx; cam.position.z += dz;
      });
    }
  }
  R.setAnimationLoop(loop);
  ready = true;
}
export function follow() { mode = "follow"; }
export function explore(x, z) { push.set(x, z); if (x || z) mode = "explore"; }
export const getMode = () => mode;

function walk(obj, dt, speedMin) {
  const path = obj.userData.path || [];
  if (!path.length) return false;
  let total = 0, prev = obj.position;
  for (const p of path) { total += p.distanceTo(prev); prev = p; }
  let step = Math.max(speedMin, total / 2.2) * dt;
  while (step > 0 && path.length) {
    const to = path[0], d = to.distanceTo(obj.position);
    if (d <= step) { obj.position.copy(to); path.shift(); step -= d; continue; }
    const dir = to.clone().sub(obj.position).normalize();
    obj.position.addScaledVector(dir, step);
    obj.rotation.y = Math.atan2(dir.x, dir.z);
    step = 0;
  }
  return true;
}

function loop() {
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
  if (document.hidden || !R.domElement.offsetParent) return;
  // Derek walks the roads
  const moving = walk(jar, dt, 4.5);
  const pose = moving ? "walk" : (jar.userData.pose || "stand"), gy = groundY(jar.position.x, jar.position.z);
  jar.rotation.x = pose === "lie" ? -Math.PI / 2 : 0;
  jar.rotation.z = pose === "surf" ? Math.sin(t * 1.7) * 0.12 : 0;
  if (pose === "lie") jar.rotation.y = 0;
  if (jar.userData.board) jar.userData.board.visible = pose === "surf";
  if (pose === "walk") jar.position.y = gy + Math.abs(Math.sin(t * 14)) * 0.08;
  else if (pose === "lie") jar.position.y = SAND_Y + 0.14;
  else if (pose === "swim") jar.position.y = WATER_Y - 0.75 + Math.sin(t * 2) * 0.05;
  else if (pose === "surf") jar.position.y = WATER_Y + 0.12 + Math.sin(t * 2.2) * 0.14;
  else jar.position.y = gy + Math.abs(Math.sin(t * 3)) * 0.03;
  for (const w of waves) w.position.z = w.userData.z0 + Math.sin(t * 0.8 + w.userData.z0) * 0.6;
  // the puppy trots after him (or naps)
  if (pup.visible) {
    const u = pup.userData;
    if (u.napping) {
      u.body.scale.set(1, 0.6, 1); u.tail.rotation.y = 0;
      pupZ.position.set(pup.position.x, 0.9 + Math.sin(t * 2) * 0.05, pup.position.z);
    } else {
      u.body.scale.set(1, 1, 1);
      const back = new THREE.Vector3(Math.sin(jar.rotation.y), 0, Math.cos(jar.rotation.y));
      let goal = jar.visible ? jar.position.clone().addScaledVector(back, -0.9).add(new THREE.Vector3(back.z * 0.5, 0, -back.x * 0.5)) : homeDoor;
      if (beach && groundY(goal.x, goal.z) === WATER_Y) goal = new THREE.Vector3(jar.position.x, SAND_Y, beach.edge);   // waits on the shore
      const d = goal.clone().sub(pup.position); d.y = 0;
      const dist = d.length();
      if (dist > 0.15) {
        pup.position.addScaledVector(d.normalize(), Math.min(dist, Math.max(3, dist * 3) * dt));
        pup.rotation.y = Math.atan2(-d.z, d.x);
        pup.position.y = groundY(pup.position.x, pup.position.z) + Math.abs(Math.sin(t * 18)) * 0.06;
      } else pup.position.y = groundY(pup.position.x, pup.position.z);
      u.tail.rotation.y = Math.sin(t * (8 + 10 * (u.bond || 0))) * 0.7;
    }
    pupZ.visible = !!u.napping;
    const e = !u.napping && WANT_EMOJI[u.want];
    bubble.visible = !!e;
    if (e) { if (bubble.material !== bubbleMat(e)) bubble.material = bubbleMat(e); bubble.position.set(pup.position.x, pup.position.y + 1.05 + Math.sin(t * 3) * 0.05, pup.position.z); }
  }
  if (bang) { bang.position.y = 2.9 + Math.sin(t * 2.5) * 0.15; bang.rotation.y += dt * 0.8; }
  for (const c of clouds) { c.position.x += dt * 0.6; if (bounds && c.position.x > bounds.cx + 90) c.position.x -= 180; }
  // camera: follow Derek, or explore with WASD / arrows / the on-screen pad
  if (mode === "follow") {
    const goal = jar.visible ? jar.position : homeDoor;
    const f = Math.min(1, dt * 2.5), dx = (goal.x - controls.target.x) * f, dz = (goal.z - controls.target.z) * f;
    controls.target.x += dx; controls.target.z += dz; cam.position.x += dx; cam.position.z += dz;
  } else {
    let mx = push.x, mz = push.y;
    if (keys.has("w") || keys.has("arrowup")) mz -= 1;
    if (keys.has("s") || keys.has("arrowdown")) mz += 1;
    if (keys.has("a") || keys.has("arrowleft")) mx -= 1;
    if (keys.has("d") || keys.has("arrowright")) mx += 1;
    if (mx || mz) {
      const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const sp = dt * Math.max(6, cam.position.distanceTo(controls.target) * 0.8);
      const mv = right.multiplyScalar(mx * sp).add(fwd.multiplyScalar(-mz * sp));
      controls.target.add(mv); cam.position.add(mv);
    }
  }
  sun.position.set(controls.target.x + 12, 22, controls.target.z + 10); sun.target.position.set(controls.target.x, 0, controls.target.z);
  controls.update();
  R.render(scene, cam);
  if (mini && (miniT += dt) > 0.2) { miniT = 0; drawMini(); }
}

const etHour = (iso) => Number(new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })) % 24;

export function update(state, town) {
  if (!ready || !town) return;
  lastState = { state, town };
  const hr = etHour(state.updated);
  night = hr < 6 || hr >= 20;
  const lucky = state.lucky || {}, luckyLive = !(lucky.date === (state.stats.today || {}).date && lucky.used >= lucky.max);
  const key = JSON.stringify([town.lots.map((l) => [l.lot, l.id]), town.site && [town.site.lot, town.site.done], town.max_lots, night, luckyLive,
                             ((state.beach && state.beach.castles) || []).map((c) => c.size), (state.owned || []).includes("surfboard")]);
  const first = !lastKey;
  if (key !== lastKey) { rebuild(town, luckyLive); lastKey = key; }
  const doing = String(state.doing || "").toLowerCase();
  let pose = "stand", goal = (places[state.place] || homeDoor).clone();
  if (state.place === "beach" && beach && !state.asleep) {
    if (doing.includes("surf")) { goal = beach.surf.clone(); pose = "surf"; }
    else if (doing.includes("swim")) { goal = beach.swim.clone(); pose = "swim"; }
    else if (doing.includes("tan")) { goal = beach.towel.clone(); pose = "lie"; }
    else if (doing.includes("sand castle")) goal = beach.castle.clone().add(new THREE.Vector3(-1.3, 0, 0.3));
  }
  jar.userData.pose = pose;
  if (jar.userData.skin) jar.userData.skin.color.set("#e9c39b").lerp(new THREE.Color("#a8683c"), Math.min(1, (state.beach && state.beach.tan) || 0));
  if (first) {   // start next to him
    jar.position.copy(goal); pup.position.copy(groundY(goal.x, goal.z) === WATER_Y && beach ? new THREE.Vector3(goal.x, SAND_Y, beach.edge) : goal).add(new THREE.Vector3(-0.8, 0, 0.4));
    controls.target.set(goal.x, 1, goal.z); cam.position.set(goal.x + (opts.full ? 9 : 7), opts.full ? 9 : 8, goal.z + (opts.full ? 15 : 12));
    jar.userData.path = [];
  } else if (!jar.userData.goal || jar.userData.goal.distanceTo(goal) > 0.1) {
    const sandy = (v) => groundY(v.x, v.z) !== Y_ROAD;
    jar.userData.path = sandy(jar.position) && sandy(goal) ? [goal]
      : sandy(goal) ? [...pathTo(jar.position, beach.gate), beach.spot.clone(), goal]
      : sandy(jar.position) ? [beach.spot.clone(), beach.gate.clone(), ...pathTo(beach.gate, goal)]
      : pathTo(jar.position, goal);
  }
  jar.userData.goal = goal;
  jar.visible = !state.asleep;
  zzz.visible = !!state.asleep;
  zzz.position.set(homeTop.cx, 4.6, homeTop.cz);
  const p = state.pup;
  pup.visible = !!p;
  if (p) {
    pup.userData.napping = p.napping || state.asleep;
    pup.userData.bond = p.bond;
    pup.userData.want = p.wants;
    if (state.asleep && first) pup.position.copy(homeDoor).add(new THREE.Vector3(-0.6, 0, 0));
  }
}
