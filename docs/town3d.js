// town3d.js: Derek's open 3D brick world (three.js from a free CDN, nothing to install).
// The town grows outward in blocks of 4 lots, with roads between them, on an island with a beach,
// the sea, and Thai limestone islands on the horizon. Derek walks the roads; his puppy follows him.
//
//   mount(el, {full, minimap})   start it in an element (full = big world page with explore controls)
//   update(state, town)          feed it the latest data (call every refresh)
//   follow()                     camera back on Derek        explore(dx, dz) nudge the explore camera
//   walkMode(on)                 walk around at ground level as your own visitor (stick(x, y) = phone joystick)
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const BLOCK = 10.4, ROAD = 3.0, P = BLOCK + ROAD;    // block plate, road width, block pitch (lots 5.2 wide since walk mode)
const SLOT = 2.6;                                     // lot centre offset inside a block
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
let garageWork = null, rideLoop = null, rideKey = "";   // where Derek stands to work on the project bike; his ride round the island
// weather + seasons (from state.weather): sky, rain/snow, lightning, season colours, snow on the ground
let wx = {}, snowy = false, palette = null, rain = null, flakes = null, flashT = 0, nextFlash = 4, sky = { bg: new THREE.Color("#8fd3ff"), hemi: 1 };
const SNOWC = "#f4f7fb";
const SEASON = {
  spring: { grass: "#5cc45a", leaf: ["#3fae4f", "#7bd389"], blossom: "#f4a6c8", sea: "#2f8fd0" },
  summer: { grass: "#47b350", leaf: ["#2e8b3d", "#3fae4f"], sea: "#2f8fd0" },
  autumn: { grass: "#8fae4a", leaf: ["#c9581f", "#e3a02b"], sea: "#2d84bf" },
  winter: { grass: "#7f9a6a", leaf: ["#2f6b45", "#3d7d55"], sea: "#3a7fb0" },
};
const SKY = {   // day sky colour, fog near/far, sun + sky light, sun colour, clouds [count, colour], stars at night
  sunny:    { bg: "#8fd3ff", fog: [70, 260], sun: 2.2, hemi: 1.0,  sunC: "#fff4e0", clouds: [8, "#ffffff"], stars: true },
  cloudy:   { bg: "#b4c3cf", fog: [55, 220], sun: 1.0, hemi: 0.95, sunC: "#eef2f6", clouds: [20, "#e4e8ec"] },
  windy:    { bg: "#9fcdea", fog: [60, 240], sun: 1.8, hemi: 1.0,  sunC: "#fff4e0", clouds: [12, "#f2f4f6"], stars: true },
  fog:      { bg: "#cdd5db", fog: [6, 48],   sun: 0.7, hemi: 1.0,  sunC: "#e8edf2", clouds: [4, "#e4e8ec"] },
  rain:     { bg: "#8a97a4", fog: [30, 140], sun: 0.6, hemi: 0.8,  sunC: "#dde4ea", clouds: [24, "#9aa3ad"] },
  storm:    { bg: "#4b5562", fog: [25, 120], sun: 0.35, hemi: 0.6, sunC: "#c8d0da", clouds: [28, "#5d6670"] },
  snow:     { bg: "#d0d8e0", fog: [25, 130], sun: 0.9, hemi: 1.05, sunC: "#e8f0ff", clouds: [22, "#e8ecf0"] },
  heatwave: { bg: "#ffdcaa", fog: [45, 190], sun: 2.6, hemi: 1.05, sunC: "#ffd9a0", clouds: [2, "#ffffff"], stars: true },
};
const keys = new Set(), push = new THREE.Vector2();
const mats = new Map(), geos = new Map();
let disposables = [], studs = [], blocks = [];
// walk mode: solids = things you bump into (world x/z boxes), rooms = walk-in buildings, plates = raised block plates,
// blockers = meshes the walk camera can't pass through
let solids = [], rooms = [], plates = [], blockers = [], jarFill = null, signs = [];
let you = null, yaw = 0, pitch = 0.2, camDist = 3.2, curD = 3.2, drag = null, stride = 0, swing = 0;
const stickV = new THREE.Vector2(), focus = new THREE.Vector3(), ray = new THREE.Raycaster();

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
  if (withStuds && snowy) add(parent, box(w + 0.02, 0.06, d + 0.02), mat(SNOWC), x, y + h + 0.03, z, 0, 0, 0, false);
  if (withStuds) studsOn(parent, x, z, w, d, y + h, snowy ? SNOWC : color);
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

// ------------------------------------------------------------------ walk mode helpers: bump boxes + walk-in buildings
const RW = 4.6, RD = 4.2, WT = 0.15;               // walk-in footprint (fills most of a 5.2 lot) + wall thickness
const ROOM_OF = { home: "home", garage: "garage", cafe: "cafe", brick_pit: "yard" };
function aabb(g, x, z, w, d) {                    // a box in a building's own space -> world x/z box
  g.updateMatrix();
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    _v.set(x + a * w / 2, 0, z + b * d / 2).applyMatrix4(g.matrix);
    x0 = Math.min(x0, _v.x); x1 = Math.max(x1, _v.x); z0 = Math.min(z0, _v.z); z1 = Math.max(z1, _v.z);
  }
  return { x0, x1, z0, z1 };
}
const solid = (g, x, z, w, d = w) => solids.push(aabb(g, x, z, w, d));
const solidAt = (x, z, w, d = w) => solids.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });
const inBox = (b, x, z, pad = 0) => x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad;
const piece = (g, w, h, d, m, x, y0, z, ry = 0) => add(g, box(w, h, d), typeof m === "string" ? mat(m) : m, x, y0 + h / 2, z, 0, ry);
const glassMat = () => night ? mat("#ffd86b", { emissive: "#ffb000", emissiveIntensity: 0.8, transparent: true, opacity: 0.8 })
                             : mat("#cfeaff", { roughness: 0.05, transparent: true, opacity: 0.3 });
function fmat(R, m) {                              // a fading copy of a material (front wall + roof go see-through when you're inside)
  const c = m.clone(); c.transparent = true; c.userData.op0 = m.transparent ? m.opacity : 1;
  disposables.push(c); R.mats.push(c); return c;
}
function texMat(w, h, draw, rx = 1, ry = 1) {
  const t = canvasTex(w, h, draw); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry);
  const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 }); disposables.push(m); return m;
}
function poster(g, w, h, x, y, z, ry, draw, px = 256) {
  const m = new THREE.MeshStandardMaterial({ map: canvasTex(px, Math.round(px * h / w), draw), roughness: 0.8 });
  const pg = new THREE.PlaneGeometry(w, h); disposables.push(m, pg);
  return add(g, pg, m, x, y, z, 0, ry, 0, false);
}
// the solid strips of a wall (length len, height h) around its holes: ops = doors/windows as {a, b, y0, y1} along the wall
function holes(len, h, ops) {
  const xs = [...new Set([-len / 2, len / 2, ...ops.flatMap((o) => [o.a, o.b])])].sort((p, q) => p - q), out = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i], b = xs[i + 1], m = (a + b) / 2;
    let y = 0;
    for (const o of ops.filter((o) => o.a <= m && o.b >= m).sort((p, q) => p.y0 - q.y0)) { if (o.y0 > y) out.push([a, b, y, o.y0]); y = Math.max(y, o.y1); }
    if (y < h) out.push([a, b, y, h]);
  }
  return out;
}
// one wall of a walk-in building (front = +z, the street side). wm = brick outside, im = the inside finish
function wallSide(R, side, ops, wm, im) {
  const { W, D, H } = R, T = WT, X = side === "front" || side === "back", front = side === "front";
  const parent = front ? R.fade : R.g, len = X ? W : D - 2 * T;
  const off = { front: D / 2 - T / 2, back: -D / 2 + T / 2, right: W / 2 - T / 2, left: -W / 2 + T / 2 }[side], inward = -Math.sign(off);
  const put = (a, b, y0, y1, m, depth, shift) => {
    const c = (a + b) / 2, L = b - a, h = y1 - y0;
    return X ? add(parent, box(L, h, depth), m, c, y0 + h / 2, off + shift) : add(parent, box(depth, h, L), m, off + shift, y0 + h / 2, c);
  };
  for (const [a, b, y0, y1] of holes(len, H, ops)) {
    const o = put(a, b, y0, y1, wm, T, 0); o.userData.fr = front ? R : null; blockers.push(o);
    if (y0 < 0.01) { if (X) solid(R.g, (a + b) / 2, off, b - a, T); else solid(R.g, off, (a + b) / 2, T, b - a); }
    if (im) {
      const lim = X ? W / 2 - T : len / 2, a2 = Math.max(a, -lim), b2 = Math.min(b, lim);
      if (b2 > a2) put(a2, b2, y0, y1, im, 0.02, inward * (T / 2 + 0.011)).castShadow = false;
    }
  }
  for (const o of ops) if (o.y0 > 0.01) put(o.a, o.b, o.y0, o.y1, front ? fmat(R, glassMat()) : glassMat(), 0.04, 0).castShadow = false;
}
function newRoom(l, g, H, roof = true) {
  const R = { id: l.place, g, W: RW, D: RD, H, roof, fade: new THREE.Group(), mats: [], f: 0, sh: true, light: null };
  g.add(R.fade);
  R.box = aabb(g, 0, 0, RW, RD);
  if (roof) { R.light = new THREE.PointLight("#ffd9a0", 0, 4.2, 1.6); R.light.position.set(0, H - 0.5, 0); g.add(R.light); }
  rooms.push(R);
  return R;
}
const floorOf = (R, m) => add(R.g, box(R.W - 2 * WT, 0.03, R.D - 2 * WT), m, 0, 0.015, 0, 0, 0, 0, false);
function studPlate(R, w, d, y, color) {           // studs on a roof that fades (its own instanced mesh)
  const pts = [];
  for (let x = -w / 2 + 0.25; x < w / 2; x += 0.5) for (let z = -d / 2 + 0.25; z < d / 2; z += 0.5) pts.push([x, z]);
  const im = new THREE.InstancedMesh(cyl(0.12, 0.12, 0.1, 10), fmat(R, mat(color)), pts.length), m4 = new THREE.Matrix4();
  pts.forEach(([x, z], i) => { m4.makeTranslation(x, y + 0.05, z); im.setMatrixAt(i, m4); });
  R.fade.add(im); disposables.push(im);
}
function flatRoof(R, c) {
  const { W, D, H } = R;
  const o = add(R.fade, box(W + 0.2, 0.2, D + 0.2), fmat(R, mat(c)), 0, H + 0.1, 0); o.userData.fr = R; blockers.push(o);
  studPlate(R, W + 0.2, D + 0.2, H + 0.2, snowy ? SNOWC : c);
  if (snowy) add(R.fade, box(W + 0.22, 0.05, D + 0.22), fmat(R, mat(SNOWC)), 0, H + 0.225, 0, 0, 0, 0, false);
}
function ceilingLamp(R) {
  const g = R.g, y = R.H;
  add(g, cyl(0.01, 0.01, 0.4, 4), mat("#333"), 0, y - 0.2, 0, 0, 0, 0, false);
  add(g, cone(0.2, 0.15, 12), mat("#3b3f46"), 0, y - 0.43, 0, 0, 0, 0, false);
  add(g, sph(0.08, 10), mat("#fff3b0", { emissive: "#ffd34d", emissiveIntensity: night ? 1.6 : 0.4 }), 0, y - 0.52, 0, 0, 0, 0, false);
}
function roomSigns(g, l, look, signY, nameX, nameY) {
  if (look.emoji) { const s = label(look.emoji, 0.95, { stroke: null }); s.position.set(0, signY, 0); g.add(s); }
  const t = label(l.name, 0.4); t.position.set(nameX, nameY, RD / 2 + 0.75); g.add(t); signs.push(t);
}
const BOOKC = ["#d0453a", "#2f6fb3", "#f2c230", "#3f9b5a", "#8e44ad", "#e8762b", "#f4f1e8"];

function roomHome(l, g, look) {                    // his house: bed, Diesel's bed, bookshelf + savings jar, old laptop, kitchen
  const H = 2.4, R = newRoom(l, g, H), c = look.color || "#c8382e", inner = "#f3e6cf", st = (lastState && lastState.state) || {};
  wallSide(R, "back", [], mat(c), mat(inner));
  wallSide(R, "left", [{ a: -1.3, b: -0.5, y0: 1.0, y1: 1.7 }], mat(c), mat(inner));
  wallSide(R, "right", [{ a: 0.3, b: 1.1, y0: 1.0, y1: 1.7 }], mat(c), mat(inner));
  wallSide(R, "front", [{ a: 0.45, b: 1.35, y0: 0, y1: 1.75 }, { a: -1.4, b: -0.4, y0: 0.9, y1: 1.7 }], fmat(R, mat(c)), fmat(R, mat(inner)));
  const rr = (RW + 0.7) / Math.SQRT2, rh = 1.5;
  const roof = add(R.fade, cone(rr, rh, 4), fmat(R, mat(look.roof || shade(c, -0.4))), 0, H + rh / 2, 0, 0, Math.PI / 4);
  roof.userData.fr = R; blockers.push(roof);
  if (snowy) add(R.fade, cone(rr * 0.68, rh * 0.68, 4), fmat(R, mat(SNOWC)), 0, H + rh * 0.66, 0, 0, Math.PI / 4);
  floorOf(R, texMat(128, 128, (x) => { x.fillStyle = "#b9824f"; x.fillRect(0, 0, 128, 128); x.fillStyle = "#8f5f35";
    for (let y = 0; y < 128; y += 16) { x.fillRect(0, y, 128, 2); x.fillRect((y * 5) % 128, y, 2, 16); x.fillRect((y * 5 + 64) % 128, y, 2, 16); } }, 2, 2));
  piece(g, 1.5, 0.01, 1.1, "#c75b39", 0.1, 0.03, 0.45); piece(g, 1.3, 0.012, 0.9, "#e8b04a", 0.1, 0.03, 0.45);   // rug
  // bed (back left) + a Thailand poster over it
  piece(g, 1.0, 0.3, 1.9, "#8b5a2b", -1.6, 0.03, -0.95); piece(g, 0.92, 0.15, 1.8, "#f4f1e8", -1.6, 0.33, -0.95);
  piece(g, 0.96, 0.07, 1.15, "#2f6fb3", -1.6, 0.46, -0.5); piece(g, 0.6, 0.12, 0.34, "#ffffff", -1.6, 0.48, -1.62);
  piece(g, 1.0, 0.8, 0.1, "#6b4423", -1.6, 0.03, -1.9);
  solid(g, -1.6, -0.95, 1.0, 1.9);
  poster(g, 0.9, 0.6, -1.6, 1.45, -1.92, 0, (x, w, h) => {
    const gr = x.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#ff9f43"); gr.addColorStop(0.55, "#ffd7a0"); gr.addColorStop(0.56, "#2f8fd0"); gr.addColorStop(1, "#1f5f8b");
    x.fillStyle = gr; x.fillRect(0, 0, w, h);
    x.fillStyle = "#fff3b0"; x.beginPath(); x.arc(w * 0.68, h * 0.42, 20, 0, 7); x.fill();
    x.fillStyle = "#3d5a3a";
    for (const [px, pw, ph] of [[24, 40, 80], [70, 28, 55], [190, 46, 72]]) { const b = h * 0.56; x.beginPath(); x.moveTo(px, b);
      x.quadraticCurveTo(px, b - ph, px + pw / 2, b - ph); x.quadraticCurveTo(px + pw, b - ph, px + pw, b); x.fill(); }
    x.fillStyle = "#fff"; x.font = "bold 30px system-ui"; x.textAlign = "center"; x.fillText("THAILAND", w / 2, h - 16);
    x.strokeStyle = "#fff"; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6);
  });
  // Diesel's bed + bowl + name plate
  add(g, cyl(0.42, 0.44, 0.16, 20), mat("#c0392b"), -0.5, 0.11, -1.45); add(g, cyl(0.32, 0.32, 0.17, 20), mat("#f2e1c1"), -0.5, 0.12, -1.45);
  add(g, cyl(0.12, 0.1, 0.07, 14), mat("#2f6fb3"), -0.45, 0.065, -0.7);
  const pupName = String((st.pup && st.pup.name) || "PUPPY").toUpperCase();
  poster(g, 0.62, 0.2, -0.5, 0.78, -1.92, 0, (x, w, h) => { x.fillStyle = "#f2c230"; x.fillRect(0, 0, w, h); x.fillStyle = "#3a2a1a";
    x.font = "bold 50px system-ui"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(pupName, w / 2, h / 2 + 3); });
  // bookshelf (back right) with the savings jar on top
  const sx = 0.9, sz = -1.76, wood = mat("#7a4a22");
  piece(g, 1.3, 1.7, 0.04, wood, sx, 0.03, -1.9);
  for (const s of [-1, 1]) piece(g, 0.06, 1.7, 0.36, wood, sx + s * 0.62, 0.03, sz);
  for (let r = 0; r < 4; r++) {
    const y = 0.03 + r * 0.42;
    piece(g, 1.3, 0.04, 0.36, wood, sx, y, sz);
    for (let x = sx - 0.58, i = 0; x < sx + 0.47; i++) {
      const w = 0.06 + rnd(`bk${r}.${i}`) * 0.05, h = 0.24 + rnd(`bh${r}.${i}`) * 0.1;
      piece(g, w, h, 0.26, BOOKC[(r * 3 + i) % 7], x + w / 2, y + 0.04, sz + 0.02); x += w + 0.012;
    }
  }
  piece(g, 1.3, 0.04, 0.36, wood, sx, 1.71, sz);
  add(g, cyl(0.12, 0.12, 0.34, 16), mat("#dff3ff", { transparent: true, opacity: 0.35, roughness: 0.05 }), sx - 0.3, 1.92, sz, 0, 0, 0, false);
  jarFill = add(g, geo("jarfill", () => new THREE.CylinderGeometry(0.1, 0.1, 0.3, 14).translate(0, 0.15, 0)), mat("#f2c230", { metalness: 0.6, roughness: 0.3 }), sx - 0.3, 1.76, sz);
  solid(g, sx, sz, 1.3, 0.36);
  // desk + his old laptop (right wall) + chair
  const dx = 1.83, dz = -0.55;
  piece(g, 0.6, 0.05, 1.0, "#a0522d", dx, 0.75, dz);
  for (const a of [-1, 1]) for (const b of [-1, 1]) piece(g, 0.05, 0.72, 0.05, "#6b4423", dx + a * 0.25, 0.03, dz + b * 0.45);
  piece(g, 0.3, 0.025, 0.42, "#3b3f46", dx, 0.8, dz);
  add(g, box(0.02, 0.28, 0.42), mat("#3b3f46"), dx + 0.16, 0.95, dz, 0, 0, -0.25);
  add(g, box(0.005, 0.24, 0.37), mat("#7fd3ff", { emissive: "#2f8fd0", emissiveIntensity: 0.8 }), dx + 0.145, 0.95, dz, 0, 0, -0.25, false);
  piece(g, 0.42, 0.05, 0.42, "#6b4423", 1.3, 0.45, dz); piece(g, 0.05, 0.5, 0.42, "#6b4423", 1.1, 0.5, dz);
  for (const a of [-1, 1]) for (const b of [-1, 1]) piece(g, 0.04, 0.42, 0.04, "#6b4423", 1.3 + a * 0.18, 0.03, dz + b * 0.18);
  solid(g, dx, dz, 0.6, 1.0); solid(g, 1.3, dz, 0.42, 0.42);
  // kitchen (left wall, front): fridge, cupboards, hob + pot, wall cupboard (+ his coffee machine once he buys it)
  const kx = -1.86;
  piece(g, 0.58, 1.75, 0.6, "#dfe6ec", kx, 0.03, 0.65); piece(g, 0.02, 0.5, 0.04, "#9aa0a6", kx + 0.3, 1.0, 0.42);
  piece(g, 0.58, 0.82, 0.95, "#f4f1e8", kx, 0.03, 1.43); piece(g, 0.62, 0.05, 0.97, "#3b3f46", kx, 0.85, 1.43);
  for (const z of [1.15, 1.45]) add(g, cyl(0.1, 0.1, 0.012, 14), mat("#111"), kx + 0.05, 0.905, z, 0, 0, 0, false);
  add(g, cyl(0.11, 0.1, 0.12, 14), mat("#9aa0a6", { metalness: 0.5, roughness: 0.3 }), kx + 0.05, 0.97, 1.15);
  piece(g, 0.36, 0.42, 0.95, "#e8d9bd", kx - 0.08, 1.45, 1.43);
  if ((st.owned || []).includes("coffee_machine")) { piece(g, 0.25, 0.3, 0.22, "#3b3f46", kx + 0.03, 0.9, 1.75); add(g, cyl(0.04, 0.035, 0.07, 10), mat("#fff"), kx + 0.12, 0.94, 1.75); }
  solid(g, kx, 1.12, 0.6, 1.6);
  // the front door, swung open inside
  piece(g, 0.06, 1.72, 0.86, "#5a3b22", 1.36, 0.03, 1.48); add(g, sph(0.035, 8), mat("#f2c230"), 1.31, 0.9, 1.2);
  solid(g, 1.36, 1.48, 0.06, 0.86);
  ceilingLamp(R);
  roomSigns(g, l, look, H + rh + 0.65, 0.9, H - 0.28);
}

function roomGarage(l, g, look) {                  // his garage: a car up on the lift, workbench + tool wall, his bike, tool chest
  const H = 2.5, R = newRoom(l, g, H), c = look.color || "#7d8590", inner = "#c9ccd1";
  wallSide(R, "back", [], mat(c), mat(inner));
  wallSide(R, "left", [{ a: -0.4, b: 0.6, y0: 1.2, y1: 1.8 }], mat(c), mat(inner));
  wallSide(R, "right", [], mat(c), mat(inner));
  wallSide(R, "front", [{ a: -1.0, b: 1.5, y0: 0, y1: 2.0 }], fmat(R, mat(c)), fmat(R, mat(inner)));
  flatRoof(R, shade(c, -0.3));
  add(R.fade, cyl(0.16, 0.16, 2.5, 14), fmat(R, mat("#c3c8cf")), 0.25, 2.15, RD / 2 - 0.35, 0, 0, Math.PI / 2);   // the roller door, rolled up
  floorOf(R, texMat(128, 128, (x) => { x.fillStyle = "#a3a7ad"; x.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 300; i++) { x.fillStyle = rnd("cn" + i) > 0.5 ? "#979ba1" : "#b0b4ba"; x.fillRect(rnd("cnx" + i) * 128, rnd("cnz" + i) * 128, 2, 2); }
    x.strokeStyle = "#8d9197"; x.lineWidth = 2; x.strokeRect(0, 0, 128, 128); }, 2, 2));
  add(g, cyl(0.45, 0.45, 0.005, 20), mat("#3a3d42", { roughness: 0.2 }), -0.85, 0.035, 0.75, 0, 0, 0, false);   // oil stain
  // two-post lift with a car on it
  const lx = -1.0, lz = -0.35, red = mat("#d0453a"), steel = mat("#3b3f46"), body = mat("#4a90c2");
  for (const s of [-1, 1]) {
    piece(g, 0.16, 2.0, 0.2, red, lx + s * 0.72, 0.03, lz); solid(g, lx + s * 0.72, lz, 0.16, 0.2);
    for (const b of [-1, 1]) piece(g, 0.5, 0.05, 0.08, steel, lx + s * 0.42, 0.95, lz + b * 0.55);
  }
  piece(g, 0.95, 0.3, 1.9, body, lx, 1.0, lz); piece(g, 0.85, 0.3, 1.0, body, lx, 1.3, lz - 0.1);
  piece(g, 0.87, 0.18, 1.02, "#bfe3ff", lx, 1.36, lz - 0.1);
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) add(g, cyl(0.19, 0.19, 0.14, 14), mat("#222"), lx + a * 0.47, 1.0, lz + b * 0.62, 0, 0, Math.PI / 2);
    piece(g, 0.18, 0.08, 0.02, "#fff3b0", lx + a * 0.3, 1.12, lz + 0.955);
  }
  solid(g, lx, lz, 1.0, 1.95);
  // workbench + tool wall (back right)
  const bx = 1.2, bz = -1.67;
  piece(g, 1.8, 0.06, 0.55, "#8b5a2b", bx, 0.78, bz); piece(g, 1.7, 0.04, 0.45, "#6b4423", bx, 0.25, bz);
  for (const a of [-1, 1]) piece(g, 0.06, 0.75, 0.5, "#6b4423", bx + a * 0.85, 0.03, bz);
  piece(g, 0.18, 0.14, 0.14, "#3b5a7a", bx - 0.65, 0.84, bz + 0.12);
  piece(g, 0.4, 0.3, 0.3, "#6d747c", bx + 0.55, 0.84, bz);
  add(g, cyl(0.07, 0.07, 0.16, 12), mat("#c9ccd1", { metalness: 0.6, roughness: 0.3 }), bx + 0.05, 0.92, bz + 0.05);   // a carb on the bench
  solid(g, bx, bz, 1.8, 0.55);
  poster(g, 1.8, 0.9, bx, 1.55, -1.92, 0, (x, w, h) => {
    x.fillStyle = "#c8a77a"; x.fillRect(0, 0, w, h); x.fillStyle = "#9c7d55";
    for (let i = 7; i < w; i += 14) for (let j = 7; j < h; j += 14) x.fillRect(i, j, 3, 3);
    x.fillStyle = "#3b3f46";
    for (let i = 0; i < 6; i++) { const px = 18 + i * 18; x.fillRect(px, 22, 6, 36 + i * 9); x.beginPath(); x.arc(px + 3, 22, 7, 0, 7); x.fill(); }   // spanners
    x.fillRect(150, 26, 8, 74); x.fillRect(137, 18, 34, 14);                                                                    // hammer
    for (let i = 0; i < 4; i++) { x.fillStyle = "#d0453a"; x.fillRect(188 + i * 15, 20, 8, 22); x.fillStyle = "#9aa0a6"; x.fillRect(190 + i * 15, 42, 4, 34 + i * 5); }
  });
  // his bike (right side, by the door)
  const kx = 1.72, kz = 0.75, orange = mat("#e8762b"), black = mat("#222"), chrome = mat("#c9ccd1", { metalness: 0.6, roughness: 0.3 });
  for (const s of [-1, 1]) add(g, geo("tyre", () => new THREE.TorusGeometry(0.24, 0.07, 8, 18)), black, kx, 0.34, kz + s * 0.55, 0, Math.PI / 2);
  piece(g, 0.1, 0.1, 1.0, orange, kx, 0.45, kz); piece(g, 0.3, 0.24, 0.45, orange, kx, 0.6, kz + 0.15);
  piece(g, 0.22, 0.08, 0.5, black, kx, 0.78, kz - 0.3); piece(g, 0.24, 0.22, 0.3, "#9aa0a6", kx, 0.28, kz + 0.05);
  add(g, cyl(0.03, 0.03, 0.62, 6), chrome, kx, 0.62, kz + 0.47, 0.35);
  add(g, cyl(0.025, 0.025, 0.6, 6), black, kx, 0.92, kz + 0.4, 0, 0, Math.PI / 2);
  add(g, cyl(0.05, 0.05, 0.5, 8), chrome, kx + 0.15, 0.4, kz - 0.4, Math.PI / 2 - 0.2);
  solid(g, kx, kz, 0.4, 1.5);
  // tool chest + oil drum
  piece(g, 0.4, 0.95, 0.6, "#c0392b", 1.92, 0.03, -0.85);
  for (let i = 0; i < 5; i++) piece(g, 0.01, 0.02, 0.5, "#7a1f16", 1.715, 0.2 + i * 0.17, -0.85);
  solid(g, 1.92, -0.85, 0.4, 0.6);
  add(g, cyl(0.24, 0.24, 0.75, 16), mat("#2f6fb3"), -1.85, 0.405, 1.6); solid(g, -1.85, 1.6, 0.5);
  // the garage project (state.garage): the bike on its stand in the middle, changing look per stage
  const G = ((lastState && lastState.state) || {}).garage || {}, p = G.project;
  g.updateMatrixWorld(true);
  garageWork = { pos: g.localToWorld(new THREE.Vector3(0.1, 0, 0.5)).setY(Y_BLOCK + 0.03), yaw: g.rotation.y + Math.PI / 2 };
  if (p) {
    const o = bikeLook(p), b = bikeModel(o); b.position.set(0.65, 0.03, 0.15); g.add(b); solid(g, 0.65, 0.15, 0.45, 1.5);
    if (o.wheels === "off") for (const x of [-0.3, -0.05]) add(g, tyreGeo(o.adv ? 1.15 : 1),
      mat("#1d1d1d", { roughness: 0.6 }), x, 0.36, -1.88, -0.12);                                    // wheels off, leaning on the back wall
    if (o.engine === false) {                                                                       // engine out on a pallet, top end off
      piece(g, 0.5, 0.06, 0.5, "#8b5a2b", 0.0, 0.03, -1.15); piece(g, 0.3, 0.28, 0.36, mat("#9aa0a6", { metalness: 0.3 }), 0.0, 0.09, -1.15);
      add(g, cyl(0.06, 0.06, 0.1, 12), mat("#e0e3e8", { metalness: 0.8, roughness: 0.2 }), 0.0, 0.42, -1.1); solid(g, 0.0, -1.15, 0.5);
    }
    if (p.wait === "soak" || p.stage_id === "carb") {                                               // carb parts soaking in a tub of cleaner
      add(g, cyl(0.12, 0.1, 0.12, 14), mat("#5b6b7a"), 1.2 - 0.3, 0.87, -1.67);
      add(g, cyl(0.105, 0.105, 0.01, 14), mat("#4fa3d9", { roughness: 0.05, transparent: true, opacity: 0.85 }), 1.2 - 0.3, 0.92, -1.67, 0, 0, 0, false);
    }
    if (p.wait === "dry") add(g, box(0.3, 0.3, 0.12), mat("#f2c230"), 1.25, 0.03 + 0.15, 0.15);     // a heater pointing at the wet paint
    const t = label(`🏍️ ${p.name || "project bike"}${p.finished ? " ✓" : ` · ${p.stages[p.stage].name}`}`, 0.28);
    t.position.set(0.65, 1.55, 0.15); g.add(t); signs.push(t);
  }
  // restored bikes he kept: parked on the street outside (the newest two)
  (G.bikes || []).slice(-2).forEach((k, i) => {
    const b = bikeModel({ adv: k.look === "adventure", paint: k.colour_hex || "#8b2b1f", shiny: true, boxes: k.look === "adventure", racks: k.look === "adventure" });
    const x = i ? 2.0 : -1.9; b.position.set(x, Y_ROAD - Y_BLOCK, 3.0); b.rotation.set(0, Math.PI / 2, 0.08); g.add(b); solid(g, x, 3.0, 1.4, 0.4);
  });
  ceilingLamp(R);
  roomSigns(g, l, look, H + 0.9, 0.25, H - 0.25);
}

// ------------------------------------------------------------------ his garage project: a bike that changes per stage
// o: { rust, paint (hex), frame (hex), engine: true/false, wheels: "on" | "flat" | "off", tank: true/false, seat: true/false,
//      stand, shiny, adv (adventure bike), racks, boxes, loom }  -> a bike along local z (front wheel at +z), ground at y 0
const tyreGeo = (k) => geo(`tyre${k}`, () => new THREE.TorusGeometry(0.24 * k, 0.07 * k, 8, 18));
function bikeModel(o = {}) {
  const g = new THREE.Group(), k = o.adv ? 1.15 : 1, R = o.rust;
  const rust = mat("#8b4a2b", { roughness: 0.95 }), rust2 = mat("#6e3b22", { roughness: 0.95 });
  const paint = R ? rust : mat(o.paint || "#8d939b", { roughness: o.shiny ? 0.25 : 0.55, metalness: o.shiny ? 0.2 : 0 });
  const frame = R ? rust2 : mat(o.frame || "#3b3f46", { roughness: 0.45 });
  const chrome = R ? rust2 : mat("#c9ccd1", { metalness: o.shiny ? 0.75 : 0.4, roughness: 0.3 });
  const tyre = mat(o.wheels === "flat" ? "#4a3a30" : "#1d1d1d", { roughness: o.wheels === "flat" ? 1 : 0.6 });
  const up = o.stand ? 0.1 : 0, r = 0.24 * k, wz = 0.55 * k;
  const tor = tyreGeo(k);
  if (o.wheels !== "off") for (const s of [-1, 1]) {
    const w = add(g, tor, tyre, 0, r + 0.07 * k + up, s * wz, 0, Math.PI / 2);
    if (o.wheels === "flat") { w.scale.set(1, 0.82, 1); w.position.y -= 0.05; }
    add(g, cyl(0.05, 0.05, 0.1, 8), chrome, 0, r + 0.07 * k + up, s * wz, 0, 0, Math.PI / 2);      // hub
  }
  const y = up + (o.wheels === "flat" ? -0.04 : 0);
  piece(g, 0.09, 0.09, 0.95 * k, frame, 0, y + 0.55 * k, 0);                                        // backbone
  add(g, box(0.08, 0.08, 0.55 * k), frame, 0, y + 0.38 * k, 0.28 * k, 0.9);                         // down tube
  if (o.engine !== false) {
    piece(g, 0.26, 0.26, 0.34, R ? rust2 : mat("#9aa0a6", { metalness: 0.3, roughness: 0.5 }), 0, y + 0.2 * k, 0.04);
    add(g, cyl(0.08, 0.08, 0.2, 10), R ? rust : mat("#b8bec6", { metalness: 0.4 }), 0, y + 0.53 * k, 0.12, -0.25);
    for (let i = 0; i < 3; i++) add(g, cyl(0.11, 0.11, 0.015, 12), R ? rust2 : mat("#8d939b"), 0, y + 0.47 * k + i * 0.05, 0.12, -0.25);
    add(g, cyl(0.04, 0.04, 0.6 * k, 8), chrome, 0.15, y + 0.3 * k, -0.28 * k, Math.PI / 2 - 0.2);  // exhaust
  }
  if (o.tank !== false) piece(g, 0.28 * k, 0.2 * k, 0.42 * k, paint, 0, y + 0.62 * k, 0.16 * k);
  if (o.seat !== false) piece(g, 0.22, 0.07, 0.5 * k, R ? mat("#5a3b22") : mat("#222"), 0, y + 0.68 * k, -0.28 * k);
  for (const s of [-1, 1]) piece(g, 0.02, 0.16, 0.22, paint, s * 0.13, y + 0.45 * k, -0.18 * k);      // side panels
  piece(g, 0.16, 0.03, 0.34, paint, 0, y + r * 2 + 0.12, wz, 0);                                      // front mudguard
  piece(g, 0.18, 0.03, 0.36 * k, paint, 0, y + 0.62 * k, -0.62 * k);                                  // tail
  for (const s of [-1, 1]) add(g, cyl(0.022, 0.022, 0.62 * k, 6), chrome, s * 0.08, y + 0.6 * k, 0.47 * k, 0.32);   // forks
  add(g, cyl(0.02, 0.02, 0.62, 6), mat("#222"), 0, y + 0.92 * k, 0.38 * k, 0, 0, Math.PI / 2);        // bars
  add(g, cyl(0.07, 0.07, 0.06, 12), R ? rust2 : mat("#fff3b0", { emissive: "#ffd34d", emissiveIntensity: night && !R ? 1 : 0.1 }),
      0, y + 0.8 * k, 0.53 * k, Math.PI / 2);                                                         // headlight
  if (o.loom) for (const [c, dx] of [["#d0453a", -0.05], ["#2f6fb3", 0], ["#f2c230", 0.05]])
    add(g, box(0.015, 0.015, 0.5), mat(c), dx, y + 0.5 * k, 0.1, 0.4);                                // loose wires
  if (o.racks) { piece(g, 0.5, 0.03, 0.4, mat("#3b3f46"), 0, y + 0.72 * k, -0.62 * k); add(g, box(0.03, 0.4, 0.03), mat("#3b3f46"), 0, y + 1.05 * k, 0.5 * k, 0.3); }
  if (o.boxes) for (const s of [-1, 1]) piece(g, 0.16, 0.3, 0.42, mat("#b8bec6", { metalness: 0.5, roughness: 0.35 }), s * 0.3, y + 0.38 * k, -0.5 * k);
  if (o.stand) { piece(g, 0.34, 0.1, 0.12, "#c0392b", 0, 0, -wz); piece(g, 0.12, y + 0.2 * k, 0.4, "#c0392b", 0, 0, 0.04); }
  return g;
}

function bikeLook(p) {                             // the project's stage -> how the bike looks right now
  const ids = p.stages.map((s) => s.id), at = p.finished ? ids.length : p.stage, past = (id) => ids.indexOf(id) >= 0 && ids.indexOf(id) < at;
  const cur = p.finished ? "done" : p.stage_id, half = !p.finished && p.stages[p.stage] && p.stages[p.stage].done * 2 >= p.stages[p.stage].need;
  const adv = p.look === "adventure", painted = past("paint") || (cur === "paint" && p.stages[p.stage].done > 0);
  const o = { adv, paint: painted ? p.colour_hex : null, stand: !p.finished, shiny: past("paint"), racks: adv && (past("racks") || cur === "racks"), boxes: adv && past("racks") };
  if (cur === "strip") return { ...o, rust: true, wheels: "flat", tank: !half, seat: !half, stand: false };
  if (!past("electrics")) Object.assign(o, { wheels: cur === "electrics" && half ? "on" : "off", loom: cur === "electrics" });
  if (cur === "engine") o.engine = false;
  return o;
}

function roomCafe(l, g, look) {                    // the cafe: counter + coffee machine + cakes, menu board, tables, a plant
  const H = 2.4, R = newRoom(l, g, H), c = look.color || "#2f8f5b", inner = "#f6ead2";
  wallSide(R, "back", [], mat(c), mat(inner));
  wallSide(R, "left", [{ a: -0.6, b: 0.6, y0: 0.9, y1: 1.7 }], mat(c), mat(inner));
  wallSide(R, "right", [], mat(c), mat(inner));
  wallSide(R, "front", [{ a: 0.55, b: 1.45, y0: 0, y1: 1.8 }, { a: -1.9, b: 0.1, y0: 0.55, y1: 1.75 }], fmat(R, mat(c)), fmat(R, mat(inner)));
  flatRoof(R, shade(c, -0.3));
  const am = new THREE.MeshStandardMaterial({ map: stripes(shade(c, -0.25), "#ffffff") }); disposables.push(am);
  add(R.fade, box(2.4, 0.08, 0.8), fmat(R, am), -0.9, 1.95, RD / 2 + 0.35, 0.35);
  floorOf(R, texMat(64, 64, (x) => { for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { x.fillStyle = (i + j) % 2 ? "#2b2b2b" : "#f4f1e8"; x.fillRect(i * 32, j * 32, 32, 32); } },
    (RW - 0.3) / 0.8, (RD - 0.3) / 0.8));
  // counter with the coffee machine, a cake display and the till
  const cz = -1.05;
  piece(g, 2.6, 0.88, 0.5, "#8b5a2b", 0.85, 0.03, cz); piece(g, 2.7, 0.06, 0.6, "#f4f1e8", 0.85, 0.91, cz);
  piece(g, 0.4, 0.45, 0.32, "#c9ccd1", 1.75, 0.97, cz - 0.05); piece(g, 0.3, 0.06, 0.1, "#3b3f46", 1.75, 1.15, cz + 0.13);
  for (const d of [-0.07, 0.07]) add(g, cyl(0.04, 0.035, 0.08, 10), mat("#ffffff"), 1.75 + d, 1.01, cz + 0.12);
  add(g, box(0.62, 0.3, 0.4), mat("#dff3ff", { transparent: true, opacity: 0.35, roughness: 0.05 }), 0.55, 1.12, cz, 0, 0, 0, false);
  for (let i = 0; i < 3; i++) add(g, cyl(0.08, 0.08, 0.1, 12), mat(["#f4a6c8", "#7a4a22", "#f2c230"][i]), 0.37 + i * 0.18, 1.02, cz);
  piece(g, 0.3, 0.2, 0.25, "#3b3f46", -0.2, 0.97, cz);
  solid(g, 0.85, cz, 2.6, 0.5);
  // shelf of jars + chalk menu on the back wall
  piece(g, 1.8, 0.04, 0.22, "#8b5a2b", 0.9, 1.15, -1.82);
  for (let i = 0; i < 6; i++) add(g, cyl(0.06, 0.06, 0.16, 10), mat(BOOKC[i]), 0.15 + i * 0.28, 1.27, -1.82);
  poster(g, 1.6, 0.6, 0.9, 1.8, -1.92, 0, (x, w, h) => {
    x.fillStyle = "#6b4423"; x.fillRect(0, 0, w, h); x.fillStyle = "#2b2b2b"; x.fillRect(8, 8, w - 16, h - 16);
    x.fillStyle = "#fff"; x.textBaseline = "middle"; x.font = "bold 26px system-ui"; x.textAlign = "center"; x.fillText("CAFE MENU", w / 2, 30);
    x.font = "20px system-ui";
    [["Coffee", 2], ["Thai iced tea", 2], ["Cake", 3], ["Toastie", 4]].forEach(([n, p], i) => {
      const y = 62 + i * 22, cx = i % 2 ? w * 0.75 : w * 0.25, yy = 62 + Math.floor(i / 2) * 24;
      x.textAlign = "center"; x.fillText(`${n} · ${p}`, cx, yy);
    });
    x.font = "italic 15px system-ui"; x.fillStyle = "#f2c230"; x.textAlign = "center"; x.fillText("prices in brick coins", w / 2, h - 20);
  }, 320);
  // two tables with stools + a plant by the door
  for (const [tx, tz] of [[-1.35, -0.45], [-1.15, 1.15]]) {
    add(g, cyl(0.36, 0.36, 0.05, 20), mat("#f4f1e8"), tx, 0.72, tz); add(g, cyl(0.05, 0.05, 0.68, 8), mat("#3b3f46"), tx, 0.38, tz);
    add(g, cyl(0.2, 0.22, 0.03, 14), mat("#3b3f46"), tx, 0.045, tz); add(g, cyl(0.045, 0.04, 0.07, 10), mat("#ffffff"), tx + 0.1, 0.78, tz);
    solid(g, tx, tz, 0.6);
    for (const s of [-1, 1]) {
      const sx = tx + s * 0.58;
      add(g, cyl(0.17, 0.17, 0.06, 14), mat("#d0453a"), sx, 0.47, tz); add(g, cyl(0.035, 0.035, 0.44, 6), mat("#3b3f46"), sx, 0.25, tz);
      solid(g, sx, tz, 0.3);
    }
  }
  add(g, cyl(0.18, 0.14, 0.3, 12), mat("#b5652e"), 1.9, 0.18, 1.65); add(g, sph(0.3, 10), mat(snowy ? "#2f6b45" : "#3fae4f"), 1.9, 0.6, 1.65);
  solid(g, 1.9, 1.65, 0.4);
  ceilingLamp(R);
  roomSigns(g, l, look, H + 0.9, 1.0, H - 0.27);
}

function studRow(g, x0, z0, x1, z1, y, color) {   // one row of studs along a low wall (in the building's own space)
  g.updateMatrix();
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 0.5));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    _v.set(x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t).applyMatrix4(g.matrix);
    studs.push([_v.x, _v.y, _v.z, color]);
  }
}
function roomYard(l, g, look) {                    // the brick pit: a low-walled yard you walk into, the big stack + the lucky ! block
  const H = 0.6, R = newRoom(l, g, H, false), wc = "#b5652e", top = snowy ? SNOWC : wc;
  for (const s of ["back", "left", "right"]) wallSide(R, s, [], mat(wc));
  wallSide(R, "front", [{ a: 0.1, b: 1.6, y0: 0, y1: H }], mat(wc));
  const e = RW / 2 - WT / 2, f = RD / 2 - WT / 2;
  studRow(g, -RW / 2, -f, RW / 2, -f, H + Y_BLOCK, top);
  studRow(g, -e, -RD / 2 + WT, -e, RD / 2 - WT, H + Y_BLOCK, top); studRow(g, e, -RD / 2 + WT, e, RD / 2 - WT, H + Y_BLOCK, top);
  studRow(g, -RW / 2, f, 0.1, f, H + Y_BLOCK, top); studRow(g, 1.6, f, RW / 2, f, H + Y_BLOCK, top);
  floorOf(R, texMat(128, 128, (x) => { x.fillStyle = snowy ? "#e8ecf0" : "#cfae78"; x.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 260; i++) { x.fillStyle = snowy ? "#d5dbe2" : ["#b8945e", "#dcc08f", "#a7834f"][i % 3]; x.fillRect(rnd("dx" + i) * 128, rnd("dz" + i) * 128, 3, 3); } }, 2, 2));
  const cols = ["#d0453a", "#f2c230", "#2f6fb3", "#3f9b5a"];
  [4, 3, 2, 1].forEach((n, row) => { for (let i = 0; i < n; i++)
    brick(g, 0.6, 0.42, 1.1, cols[(i + row) % 4], -0.85 - n * 0.32 + i * 0.64 + 0.32, 0.03 + row * 0.42, -1.2 + (row % 2) * 0.15); });
  solid(g, -0.85, -1.12, 2.6, 1.3);
  for (const [x, z, lv, k] of [[1.05, -1.55, 0, 0], [1.6, -1.55, 0, 1], [1.33, -1.0, 0, 2], [1.33, -1.55, 1, 3], [1.85, -1.0, 0, 1]])
    brick(g, 0.5, 0.36, 0.5, cols[k], x, 0.03 + lv * 0.36, z);
  solid(g, 1.45, -1.3, 1.3, 1.1);
  if (((lastState && lastState.state.owned) || []).includes("wheelbarrow")) {
    const wb = new THREE.Group(); wb.position.set(-1.45, 0.03, 0.95); wb.rotation.y = 0.5; g.add(wb);
    add(wb, box(0.6, 0.25, 0.8), mat("#2f6fb3"), 0, 0.45, 0, 0.08); add(wb, cyl(0.16, 0.16, 0.08, 12), mat("#222"), 0, 0.18, 0.5, 0, 0, Math.PI / 2);
    for (const s of [-1, 1]) { add(wb, box(0.05, 0.05, 0.9), mat("#8b5a2b"), s * 0.25, 0.42, -0.55, -0.15); add(wb, box(0.05, 0.3, 0.05), mat("#3b3f46"), s * 0.22, 0.17, -0.25); }
    for (let i = 0; i < 3; i++) brick(wb, 0.22, 0.15, 0.4, cols[i], -0.17 + i * 0.17, 0.55, 0, false);
    solid(g, -1.45, 0.95, 1.0);
  }
  add(g, box(0.06, 1.0, 0.06), mat("#8b5a2b"), -1.25, 0.5, RD / 2 + 0.12);
  poster(g, 0.9, 0.32, -1.25, 1.05, RD / 2 + 0.16, 0, (x, w, h) => { x.fillStyle = "#fbf3e4"; x.fillRect(0, 0, w, h); x.strokeStyle = "#3a2a1a"; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6);
    x.fillStyle = "#3a2a1a"; x.font = "bold 44px system-ui"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("FREE BRICKS", w / 2, h / 2 + 2); });
  const face = canvasTex(64, 64, (x) => { x.fillStyle = "#f5b81b"; x.fillRect(0, 0, 64, 64); x.strokeStyle = "#7a4f00"; x.lineWidth = 6; x.strokeRect(3, 3, 58, 58);
    x.fillStyle = "#fff"; x.font = "900 44px system-ui"; x.textAlign = "center"; x.textBaseline = "middle"; x.lineWidth = 4; x.strokeText("!", 32, 34); x.fillText("!", 32, 34); });
  bang = add(g, box(0.8, 0.8, 0.8), new THREE.MeshStandardMaterial({ map: face, roughness: 0.5 }), -0.85, 2.9, -1.1);
  disposables.push(bang.material);
  const t = label(l.name, 0.4); t.position.set(0.85, 1.25, RD / 2 + 0.75); g.add(t); signs.push(t);
}
const ROOM_BUILD = { home: roomHome, garage: roomGarage, cafe: roomCafe, yard: roomYard };

// ------------------------------------------------------------------ buildings (same brick style as before)
function tree(g, x, z, seed, s = 1) {
  s *= 0.85 + (seed % 5) / 12;
  add(g, cyl(0.14, 0.18, 0.9 * s), mat("#7a4a22"), x, 0.45 * s, z);
  const L = (palette || SEASON.summer).leaf;
  const top = snowy ? SNOWC : palette && palette.blossom && seed % 3 === 0 ? palette.blossom : L[(seed + 1) % 2];
  add(g, cone(0.85 * s, 1.2 * s), mat(L[seed % 2]), x, 1.35 * s, z);
  add(g, cone(0.6 * s, 0.9 * s), mat(top), x, 1.95 * s, z);
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
  if (ROOM_OF[l.place]) { ROOM_BUILD[ROOM_OF[l.place]](l, g, look); return spot; }   // walk-in starter buildings
  const f = Math.max(1, Math.min(4, look.floors || 1));
  const sign = (y) => { if (look.emoji) { const s = label(look.emoji, 0.95, { stroke: null }); s.position.set(0, y, 0.2); g.add(s); } };
  switch (kind) {
    case "house": {
      const h = 1.25 * f + 0.35;
      blockers.push(brick(g, 3, h, 2.6, c, 0, 0, 0, false)); solid(g, 0, 0, 3, 2.6);
      add(g, cone(2.2, 1.3, 4), mat(look.roof || shade(c, -0.4)), 0, h + 0.65, 0, 0, Math.PI / 4);
      if (snowy) add(g, cone(1.5, 0.88, 4), mat(SNOWC), 0, h + 0.87, 0, 0, Math.PI / 4);
      add(g, box(0.7, 1.0, 0.1), mat("#5a3b22"), 0, 0.5, 1.31);
      for (let i = 0; i < f; i++) for (const x of [-0.95, 0.95]) add(g, box(0.6, 0.55, 0.08), winMat(), x, 0.8 + 1.25 * i, 1.31);
      sign(h + 1.9); break;
    }
    case "garage": {
      blockers.push(brick(g, 3.2, 1.9, 2.6, c, 0, 0, 0)); solid(g, 0, 0, 3.2, 2.6);
      const dm = new THREE.MeshStandardMaterial({ map: canvasTex(64, 64, (x) => {
        x.fillStyle = "#c3c8cf"; x.fillRect(0, 0, 64, 64); x.fillStyle = "#8a9099"; for (let y = 6; y < 64; y += 9) x.fillRect(0, y, 64, 2); }) });
      disposables.push(dm);
      add(g, box(1.9, 1.35, 0.08), dm, -0.45, 0.68, 1.31);
      add(g, box(0.6, 1.0, 0.08), mat("#3b3f46"), 1.05, 0.5, 1.31);
      sign(2.6); break;
    }
    case "tower": {
      const h = 1.1 * f + 1.2;
      blockers.push(brick(g, 1.6, h, 1.6, c, 0, 0, 0)); solid(g, 0, 0, 1.6);
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
      tree(g, 0.8, -0.3, hash(l.id)); solid(g, 0.8, -0.3, 0.5); solid(g, -0.6, 0.7, 1.4, 0.5);
      add(g, box(1.4, 0.1, 0.45), mat("#8b5a2b"), -0.6, 0.5, 0.7);
      add(g, box(1.4, 0.4, 0.08), mat("#8b5a2b"), -0.6, 0.75, 0.5);
      for (const x of [-1.2, 0]) add(g, box(0.1, 0.45, 0.4), mat("#5a3b22"), x, 0.25, 0.7);
      break;
    case "track": {
      for (const [x, r] of [[-1.1, 0.55], [0.1, 0.4], [1.1, 0.6]]) { add(g, cyl(r, r, 2.4, 20), mat("#8d6e63"), x, 0, 0, Math.PI / 2); solid(g, x, 0, 2 * r, 2.4); }
      add(g, cyl(0.04, 0.04, 2.2), mat("#333"), 1.6, 1.1, 1.0);
      const fm = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, map: canvasTex(32, 32, (x) => {
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { x.fillStyle = (i + j) % 2 ? "#111" : "#fff"; x.fillRect(i * 8, j * 8, 8, 8); } }) });
      disposables.push(fm);
      const pl = new THREE.PlaneGeometry(0.7, 0.5); disposables.push(pl);
      add(g, pl, fm, 1.95, 1.95, 1.0);
      sign(2.6); break;
    }
    case "tree": tree(g, 0, 0, hash(l.id)); solid(g, 0, 0, 0.5); break;
    case "lamp": lamp(g, 0, 0.9, 1); solid(g, 0, 0.9, 0.2); break;
    case "flowers": {
      brick(g, 2.4, 0.25, 1.0, "#6b4423", 0, 0, 0.6, false); solid(g, 0, 0.6, 2.4, 1.0);
      const fc = ["#e74c3c", "#f1c40f", "#9b59b6", "#ffffff", "#e67e22"];
      for (let i = 0; i < 6; i++) {
        const x = -1 + i * 0.4;
        add(g, cyl(0.025, 0.025, 0.4, 6), mat("#2e8b3d"), x, 0.45, 0.6);
        add(g, sph(0.11, 10), mat(fc[(i + hash(l.id)) % 5]), x, 0.68, 0.6);
      }
      break;
    }
    case "fountain":
      add(g, cyl(1.3, 1.4, 0.45, 28), mat("#9aa5b1"), 0, 0.22, 0.3); solid(g, 0, 0.3, 2.7);
      add(g, cyl(1.12, 1.12, 0.47, 28), mat("#5dade2", { roughness: 0.1 }), 0, 0.24, 0.3);
      add(g, cyl(0.14, 0.18, 1.0), mat("#9aa5b1"), 0, 0.9, 0.3);
      add(g, cyl(0.55, 0.3, 0.18, 20), mat("#9aa5b1"), 0, 1.45, 0.3);
      add(g, cyl(0.05, 0.35, 0.7, 14), mat("#8fd3ff", { transparent: true, opacity: 0.6 }), 0, 1.85, 0.3);
      break;
    case "stall": {
      add(g, box(2.4, 0.8, 1.0), mat("#a0522d"), 0, 0.4, 0.6); solid(g, 0, 0.6, 2.4, 1.0);
      for (const [x, z] of [[-1.25, 0.15], [1.25, 0.15], [-1.25, 1.1], [1.25, 1.1]]) add(g, cyl(0.05, 0.05, 2.0, 8), mat("#ddd"), x, 1.0, z);
      const cm = new THREE.MeshStandardMaterial({ map: stripes(c, "#ffffff") }); disposables.push(cm);
      add(g, box(2.9, 0.12, 1.5), cm, 0, 2.05, 0.6, 0.12);
      for (let i = 0; i < 4; i++) brick(g, 0.35, 0.25, 0.35, ["#f2c230", "#d0453a", "#3f9b5a", "#e8762b"][i], -0.9 + i * 0.6, 0.8, 0.6);
      sign(2.8); break;
    }
    default: {   // "shop" and his own designs
      const h = 1.6 + 1.1 * (f - 1);
      blockers.push(brick(g, 3, h, 2.6, c, 0, 0, 0)); solid(g, 0, 0, 3, 2.6);
      for (let i = 1; i < f; i++) for (const x of [-0.95, 0.95]) add(g, box(0.6, 0.55, 0.08), winMat(), x, 1.6 + 1.1 * (i - 1) + 0.4, 1.31);
      const am = new THREE.MeshStandardMaterial({ map: stripes(shade(c, -0.25), "#ffffff") }); disposables.push(am);
      add(g, box(3.2, 0.1, 0.9), am, 0, 1.35, 1.65, 0.35);
      add(g, box(1.1, 0.7, 0.08), winMat(), -0.6, 0.6, 1.31);
      add(g, box(0.6, 1.0, 0.08), mat("#5a3b22"), 0.9, 0.5, 1.31);
      sign(h + 0.9);
    }
  }
  if (!/^(tree|lamp|flowers)$/.test(kind)) { const t = label(l.name, 0.4); t.position.set(0, 0.5, 2.1); g.add(t); signs.push(t); }
  return spot;
}
function site(s) {
  const spot = lotSpot(s.lot);
  const g = new THREE.Group(); g.position.set(spot.cx, Y_BLOCK, spot.cz); g.rotation.y = spot.face; root.add(g);
  const c = (s.look && s.look.color) || "#9aa5b1", frac = Math.max(0.08, s.done / s.work);
  add(g, box(2.8, 2.4 * frac, 2.4), mat(c, { transparent: true, opacity: 0.75 }), 0, 1.2 * frac, 0);
  solid(g, 0, 0, 3.1, 2.7);
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

function snowman(g, x, z, size) {
  const sn = mat("#fbfdff"), coal = mat("#222"), y0 = Y_ROAD;
  add(g, sph(0.55, 16), sn, x, y0 + 0.5, z);
  if (size >= 2) add(g, sph(0.4, 16), sn, x, y0 + 1.25, z);
  if (size >= 3) {
    add(g, sph(0.3, 16), sn, x, y0 + 1.8, z);
    for (const dx of [-0.1, 0.1]) add(g, sph(0.04, 8), coal, x + dx, y0 + 1.86, z + 0.27);
    add(g, cone(0.05, 0.35, 8), mat("#ff8c1a"), x, y0 + 1.8, z + 0.42, Math.PI / 2);
    add(g, cyl(0.27, 0.27, 0.12, 18), mat("#e8762b"), x, y0 + 2.08, z);        // Derek's old orange cap
    add(g, box(0.3, 0.04, 0.22), mat("#e8762b"), x, y0 + 2.04, z + 0.28);
    for (const s of [-1, 1]) add(g, cyl(0.025, 0.025, 0.7, 6), mat("#6b4423"), x + s * 0.55, y0 + 1.35, z, 0, 0, s * 1.0);
  }
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
  const umb = new THREE.Group(); umb.position.set(0.47, 0.95, 0.05); umb.visible = false; g.add(umb);   // rain or snow
  add(umb, cyl(0.03, 0.03, 1.3, 6), mat("#3b3f46"), 0, 0.65, 0);
  add(umb, cone(0.8, 0.35, 10), mat("#2f6fb3"), 0, 1.35, 0);
  g.userData.skin = skin; g.userData.board = board; g.userData.umbrella = umb;
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
function makeVisitor() {   // you: red shirt, jeans, sunglasses (legs + arms swing when you walk)
  const g = new THREE.Group();
  const skin = mat("#e9c39b"), shirt = mat("#d0453a"), jeans = mat("#34495e"), shoe = mat("#222"), hair = mat("#5a3b22"), ink = mat("#1d1d1d");
  const limb = (x, y) => { const p = new THREE.Group(); p.position.set(x, y, 0); g.add(p); return p; };
  const legs = [-0.16, 0.16].map((x) => { const p = limb(x, 0.7); add(p, box(0.28, 0.55, 0.32), jeans, 0, -0.27, 0); add(p, box(0.3, 0.16, 0.42), shoe, 0, -0.62, 0.04); return p; });
  add(g, box(0.64, 0.14, 0.34), jeans, 0, 0.76, 0);
  add(g, box(0.68, 0.62, 0.36), shirt, 0, 1.13, 0);
  add(g, box(0.5, 0.07, 0.02), mat("#ffffff"), 0, 1.22, 0.19);
  const arms = [-1, 1].map((s) => { const p = limb(s * 0.43, 1.38);
    add(p, box(0.17, 0.52, 0.22), shirt, 0, -0.26, 0, 0, 0, s * 0.12); add(p, cyl(0.08, 0.08, 0.14, 10), skin, s * 0.04, -0.58, 0.02); return p; });
  add(g, cyl(0.1, 0.1, 0.08), skin, 0, 1.48, 0);
  add(g, cyl(0.24, 0.24, 0.42, 22), skin, 0, 1.72, 0);
  add(g, box(0.38, 0.08, 0.05), ink, 0, 1.77, 0.215);
  add(g, box(0.12, 0.025, 0.02), ink, 0, 1.63, 0.24);
  add(g, cyl(0.265, 0.265, 0.12, 22), hair, 0, 1.97, -0.01); add(g, box(0.5, 0.3, 0.12), hair, 0, 1.84, -0.19);
  g.userData = { legs, arms };
  g.scale.setScalar(0.62); g.visible = false;
  return g;
}

// ------------------------------------------------------------------ the world
function rebuild(town, luckyLive) {
  if (root) { scene.remove(root); for (const d of disposables) d.dispose(); }
  disposables = []; studs = []; clouds = []; bang = null;
  solids = []; rooms = []; plates = []; blockers = []; jarFill = null; signs = [];
  root = new THREE.Group(); scene.add(root);
  palette = SEASON[wx.season] || SEASON.summer;
  snowy = (wx.snow || 0) >= 0.15;
  const grass = snowy ? "#" + new THREE.Color(palette.grass).lerp(new THREE.Color(SNOWC), Math.min(1, wx.snow * 1.6)).getHexString() : palette.grass;
  const SK = SKY[wx.kind] || SKY.sunny;
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
  add(root, seaGeo, mat(wx.kind === "storm" ? "#24597f" : palette.sea, { roughness: 0.2, metalness: 0.1 }), cx, -0.55, cz, -Math.PI / 2, 0, 0, false);
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
  solidAt(beach.towel.x + 0.9, beach.towel.z - 0.6, 0.12);
  const st = lastState && lastState.state;
  if (st && (st.owned || []).includes("surfboard")) add(root, box(0.5, 1.9, 0.09), mat("#f6b24a"), cx - 3.8, SAND_Y + 0.85, bzz - 0.3, 0, 0, 0.15);
  for (const c of ((st && st.beach && st.beach.castles) || []).slice(-1)) { castle(root, beach.castle.x, beach.castle.z, c.size); solidAt(beach.castle.x, beach.castle.z, 1.4); }
  {                                                    // his ride on a restored bike: round the town's ring road + along the wet sand
    const rz = bzz + 1.3, sx0 = cx - isle.w / 2 + 3, sx1 = cx + isle.w / 2 - 3, gx = beach.gate.x, b = bounds;
    rideLoop = [V(b.x0, Y_ROAD, b.z0), V(b.x1, Y_ROAD, b.z0), V(b.x1, Y_ROAD, b.z1), V(gx, Y_ROAD, b.z1), V(gx, SAND_Y, rz), V(sx1, SAND_Y, rz),
                V(sx0, SAND_Y, rz), V(gx, SAND_Y, rz), V(gx, Y_ROAD, b.z1), V(b.x0, Y_ROAD, b.z1)];
  }
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
  const ground = new THREE.Mesh(groundGeo, [side, side, mat(grass), side, side, side]);
  ground.position.set(cx, -0.25, cz); ground.receiveShadow = true; root.add(ground);
  studsOn(root, cx, cz, isle.w, isle.d, 0, grass, 1.0);

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
    const plate = snowy ? "#e8ecf0" : "#c9c4b8";
    add(root, box(BLOCK, Y_BLOCK, BLOCK), mat(plate), bx * P, Y_BLOCK / 2, bz * P, 0, 0, 0, false);
    plates.push({ x0: bx * P - BLOCK / 2, x1: bx * P + BLOCK / 2, z0: bz * P - BLOCK / 2, z1: bz * P + BLOCK / 2 });
    studsOn(root, bx * P, bz * P, BLOCK, BLOCK, Y_BLOCK, plate);
  }
  // street lamps at the crossings
  const crossings = new Set();
  for (const [a, b] of used) for (const sx of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) crossings.add(`${(a + sx) * P},${(b + sz) * P}`);
  for (const k of crossings) { const [x, z] = k.split(",").map(Number); lamp(root, x + ROAD / 2 - 0.2, z + ROAD / 2 - 0.2, 1.1); solidAt(x + ROAD / 2 - 0.2, z + ROAD / 2 - 0.2, 0.2); }

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
  if (snowy && wx.snowman) { snowman(root, homeDoor.x + 1.6, homeDoor.z, wx.snowman); solidAt(homeDoor.x + 1.6, homeDoor.z, 1.0); }
  if (!snowy && (wx.wet || 0) >= 0.35) {                 // puddles on the roads after rain
    const pm = mat("#9cc3e6", { roughness: 0.05, metalness: 0.1, emissive: "#1d3a52", transparent: true, opacity: 0.85 });
    for (let i = 0; i < 26; i++) {
      const r = 0.4 + rnd("pr" + i) * 0.6, along = (a, b) => a + rnd("pa" + i) * (b - a), jig = (rnd("po" + i) - 0.5) * 1.6;
      const [x, z] = i % 2 ? [along(bounds.x0, bounds.x1), roadLine(along(bounds.z0, bounds.z1)) + jig]
                           : [roadLine(along(bounds.x0, bounds.x1)) + jig, along(bounds.z0, bounds.z1)];
      add(root, cyl(r, r, 0.02, 18), pm, x, 0.06, z, 0, 0, 0, false);
    }
  }
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
    if (t < 0.45) { tree(nat, x, z, hash("s" + i), 1.1); solidAt(x, z, 0.5); }
    else if (t < 0.65) { const r = 0.5 + rnd("r" + i) * 0.4; add(nat, sph(r, 10), mat(snowy ? "#e6ecf1" : palette.leaf[i % 2]), x, 0.25, z); solidAt(x, z, r * 1.5); }
    else if (t < 0.8) { add(nat, box(0.9, 0.6, 0.7), mat("#9aa0a6"), x, 0.3, z, 0, rnd("a" + i) * 3); solidAt(x, z, 0.9); }
    else for (let k = 0; k < 3; k++) add(nat, sph(0.12, 8), mat(["#e74c3c", "#f1c40f", "#ffffff"][k]), x + k * 0.3, 0.15, z + (k % 2) * 0.3, 0, 0, 0, false);
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + rnd("pa" + i) * 0.3;
    const hx = isle.w / 2 + 2.5, hz = isle.d / 2 + 2.5, k = 1 / Math.max(Math.abs(Math.cos(a)) / hx, Math.abs(Math.sin(a)) / hz);
    palm(nat, cx + Math.cos(a) * k, cz + Math.sin(a) * k, i); solidAt(cx + Math.cos(a) * k, cz + Math.sin(a) * k, 0.4);
  }
  // Thai limestone islands on the horizon (the dream)
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.4, dist = 120 + rnd("kd" + i) * 70, h = 18 + rnd("kh" + i) * 22, r = 5 + rnd("kr" + i) * 6;
    const kx = cx + Math.cos(a) * dist, kz = cz + Math.sin(a) * dist;
    add(root, cyl(r * 0.55, r, h, 10), mat("#7d8c74", { roughness: 1 }), kx, h / 2 - 1, kz, 0, 0, 0, false);
    add(root, sph(r * 0.6, 10), mat("#4f7d4a", { roughness: 1 }), kx, h - 1, kz, 0, 0, 0, false);
  }
  // clouds
  const heavy = ["rain", "storm", "snow"].includes(wx.kind);
  for (let i = 0; i < SK.clouds[0]; i++) {
    const cl = new THREE.Group(); cl.position.set(cx + (rnd("cx" + i) - 0.5) * 160, (heavy ? 13 : 16) + rnd("cy" + i) * 8, cz + (rnd("cz" + i) - 0.5) * 160);
    const cm = mat(SK.clouds[1], { transparent: true, opacity: night ? (heavy ? 0.5 : 0.15) : 0.92 });
    for (const [dx, dy, r] of [[0, 0, 2.2], [2.2, 0.3, 1.8], [-2.2, 0.2, 1.6], [0.8, 1.3, 1.6]]) add(cl, sph(r, 12), cm, dx, dy, 0, 0, 0, 0, false);
    root.add(cl); clouds.push(cl);
  }
  if (night && SK.stars) {
    const pts = []; for (let i = 0; i < 700; i++) { const a = rnd("sa" + i) * Math.PI * 2, e = 0.15 + rnd("se" + i) * 1.3, d = 300;
      pts.push(cx + Math.cos(a) * Math.cos(e) * d, Math.sin(e) * d, cz + Math.sin(a) * Math.cos(e) * d); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const sm = new THREE.PointsMaterial({ color: "#ffffff", size: 1.2, sizeAttenuation: false }); disposables.push(sg, sm);
    root.add(new THREE.Points(sg, sm));
  }
  if (bang && !luckyLive) bang.material.color.set("#8a8a8a");

  // every stud in one instanced mesh (none under the walk-in floors)
  studs = studs.filter(([x, y, z]) => y > Y_BLOCK + 0.05 || !rooms.some((R) => inBox(R.box, x, z)));
  if (studMesh) { scene.remove(studMesh); studMesh.material.dispose(); studMesh.dispose(); }
  studMesh = new THREE.InstancedMesh(cyl(0.12, 0.12, 0.1, 10), new THREE.MeshStandardMaterial({ roughness: 0.42 }), studs.length);
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  studs.forEach(([x, y, z, c], i) => { m4.makeTranslation(x, y + 0.05, z); studMesh.setMatrixAt(i, m4); studMesh.setColorAt(i, col.set(c)); });
  studMesh.receiveShadow = true;
  scene.add(studMesh);

  sky.bg = new THREE.Color(SK.bg); if (night) sky.bg.lerp(new THREE.Color("#0b1433"), 0.85);
  scene.background = sky.bg.clone();
  const fk = opts.full ? 1 : 0.6;
  scene.fog = new THREE.Fog(scene.background, SK.fog[0] * fk, SK.fog[1] * fk);
  sky.hemi = night ? 0.35 : SK.hemi;
  hemi.intensity = sky.hemi; hemi.color.set(night ? "#7080c0" : "#ffffff");
  sun.intensity = night ? 0.25 : SK.sun; sun.color.set(night ? "#9fb4ff" : SK.sunC);
}

// ------------------------------------------------------------------ minimap (top-down, north up)
function drawMini() {
  if (!mini || !bounds) return;
  const g = mini.getContext("2d"), W = mini.width, H = mini.height, isle = bounds.isle;
  const s = Math.min(W, H) / (Math.max(isle.w, isle.d) + 16);
  const X = (x) => W / 2 + (x - bounds.cx) * s, Z = (z) => H / 2 + (z - bounds.cz) * s;
  g.fillStyle = night ? "#123a5a" : "#3c9ad6"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#f2d28b"; g.fillRect(X(bounds.cx - isle.w / 2 - 5), Z(bounds.cz - isle.d / 2 - 5), (isle.w + 10) * s, (isle.d + 10) * s);
  g.fillStyle = snowy ? (night ? "#7d8796" : "#eef2f6") : night ? "#2f6b3a" : "#55b85e"; g.fillRect(X(bounds.cx - isle.w / 2), Z(bounds.cz - isle.d / 2), isle.w * s, isle.d * s);
  g.fillStyle = "#666b73"; g.fillRect(X(bounds.x0 - ROAD / 2), Z(bounds.z0 - ROAD / 2), (bounds.x1 - bounds.x0 + ROAD) * s, (bounds.z1 - bounds.z0 + ROAD) * s);
  const town = lastState ? lastState.town : { lots: [] };
  for (const l of town.lots) {
    const sp = lotSpot(l.lot), look = l.look || {}, [fw, fd] = ROOM_OF[l.place] ? [RW, RD] : [3.2, 2.8];
    g.fillStyle = look.color || (look.kind === "pit" ? "#f2c230" : "#58b05f");
    g.fillRect(X(sp.cx - fw / 2), Z(sp.cz - fd / 2), fw * s, fd * s);
  }
  if (town.site) { const sp = lotSpot(town.site.lot); g.strokeStyle = "#ff9b2f"; g.lineWidth = 2; g.strokeRect(X(sp.cx - 1.6), Z(sp.cz - 1.4), 3.2 * s, 2.8 * s); }
  const dot = (v, col, r) => { g.fillStyle = col; g.beginPath(); g.arc(X(v.x), Z(v.z), r, 0, 7); g.fill(); g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.stroke(); };
  if (pup.visible) dot(pup.position, "#b07a4a", 3.5);
  dot(jar.visible ? jar.position : homeDoor, "#e8762b", 5);
  const t = focus, dir = new THREE.Vector3(); cam.getWorldDirection(dir);   // where you are + where you're looking
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
  you = makeVisitor(); scene.add(you);
  zzz = label("Zzz", 0.9); zzz.visible = false; scene.add(zzz);
  pupZ = label("z", 0.5); pupZ.visible = false; scene.add(pupZ);
  bubble = new THREE.Sprite(bubbleMat("🎾")); bubble.scale.set(0.7, 0.7, 1); bubble.visible = false; scene.add(bubble);
  makePrecip();
  clock = new THREE.Clock();
  const fit = () => { const w = el.clientWidth || 600, h = el.clientHeight || 340; R.setSize(w, h, false);
    R.domElement.style.width = "100%"; R.domElement.style.height = "100%"; cam.aspect = w / h; if (mode === "walk") lens(); else cam.updateProjectionMatrix(); };
  new ResizeObserver(fit).observe(el); fit();
  if (opts.full) {
    addEventListener("keydown", (e) => {
      if (e.key === "Shift") { keys.add("shift"); return; }
      if (/^(w|a|s|d|arrowup|arrowdown|arrowleft|arrowright)$/i.test(e.key)) { keys.add(e.key.toLowerCase()); if (mode !== "walk") mode = "explore"; e.preventDefault(); }
    });
    addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
    addEventListener("blur", () => keys.clear());
    if (opts.minimap) {
      mini = opts.minimap;
      mini.addEventListener("click", (e) => {
        if (!mini._toWorld) return;
        const r = mini.getBoundingClientRect();
        const p = mini._toWorld((e.clientX - r.left) * mini.width / r.width, (e.clientY - r.top) * mini.height / r.height);
        if (mode === "walk") { you.position.set(p.x, floorY(p.x, p.z), p.z); collide(you.position); return; }   // walk: jump there
        mode = "explore";
        const dx = p.x - controls.target.x, dz = p.z - controls.target.z;
        controls.target.x += dx; controls.target.z += dz; cam.position.x += dx; cam.position.z += dz;
      });
    }
  }
  if (opts.full) {   // walk mode: drag to turn + look up/down, scroll to move the camera in/out
    const cv = R.domElement;
    cv.addEventListener("pointerdown", (e) => { if (mode !== "walk") return; drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id || mode !== "walk") return;
      yaw -= (e.clientX - drag.x) * 0.006; pitch = Math.max(-0.3, Math.min(0.95, pitch + (e.clientY - drag.y) * 0.004));
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const up = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", (e) => { if (mode !== "walk") return; camDist = Math.max(1.2, Math.min(6, camDist * (1 + e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });
  }
  R.setAnimationLoop(loop);
  ready = true;
}
function makePrecip() {
  const N = 3000, seeds = () => Float32Array.from({ length: N * 3 }, (_, i) => (i % 3 === 1 ? Math.random() * 30 : Math.random() * 60 - 30));
  const rg = new THREE.BufferGeometry(); rg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 6), 3));
  rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: "#d5dee8", transparent: true, opacity: 0.55, depthWrite: false }));
  rain.frustumCulled = false; rain.visible = false; rain.userData = { p: seeds(), n: N }; scene.add(rain);
  const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  flakes = new THREE.Points(sg, new THREE.PointsMaterial({ color: "#ffffff", size: 0.17, transparent: true, opacity: 0.95, depthWrite: false }));
  flakes.frustumCulled = false; flakes.visible = false; flakes.userData = { p: seeds(), n: N }; scene.add(flakes);
}
const wrap = (v, c) => (v - c > 30 ? v - 60 : v - c < -30 ? v + 60 : v);
function stepPrecip(dt, t) {
  const c = focus, kind = wx.kind, dry = mode === "walk" ? rooms.filter((R) => R.roof) : [];
  const under = (x, z) => { for (const R of dry) if (inBox(R.box, x, z)) return true; return false; };
  rain.visible = kind === "rain" || kind === "storm";
  flakes.visible = kind === "snow";
  if (rain.visible) {
    const u = rain.userData, n = kind === "storm" ? u.n : (u.n * 0.55) | 0, pos = rain.geometry.attributes.position.array, slant = kind === "storm" ? 0.35 : 0.12;
    for (let i = 0; i < n; i++) {
      const j = i * 3; u.p[j + 1] -= dt * 26; if (u.p[j + 1] < 0) u.p[j + 1] += 30;
      u.p[j] = wrap(u.p[j], c.x); u.p[j + 2] = wrap(u.p[j + 2], c.z);
      const k = i * 6;
      const hide = dry.length && under(u.p[j], u.p[j + 2]) ? -60 : 0;
      pos[k] = u.p[j]; pos[k + 1] = u.p[j + 1] + hide; pos[k + 2] = u.p[j + 2];
      pos[k + 3] = u.p[j] + slant; pos[k + 4] = u.p[j + 1] - 0.55 + hide; pos[k + 5] = u.p[j + 2];
    }
    rain.geometry.setDrawRange(0, n * 2); rain.geometry.attributes.position.needsUpdate = true;
  }
  if (flakes.visible) {
    const u = flakes.userData, pos = flakes.geometry.attributes.position.array;
    for (let i = 0; i < u.n; i++) {
      const j = i * 3; u.p[j + 1] -= dt * 1.6; if (u.p[j + 1] < 0) u.p[j + 1] += 30;
      u.p[j] = wrap(u.p[j] + Math.sin(t * 0.8 + i) * dt * 0.4, c.x); u.p[j + 2] = wrap(u.p[j + 2] + Math.cos(t * 0.6 + i) * dt * 0.3, c.z);
      pos[j] = u.p[j]; pos[j + 1] = u.p[j + 1] - (dry.length && under(u.p[j], u.p[j + 2]) ? 60 : 0); pos[j + 2] = u.p[j + 2];
    }
    flakes.geometry.attributes.position.needsUpdate = true;
  }
  // lightning: a white flash every few seconds in a storm
  if (kind === "storm") {
    if ((nextFlash -= dt) <= 0) { flashT = 0.22; nextFlash = 3 + Math.random() * 9; }
    if (flashT > 0) {
      flashT -= dt;
      const on = Math.random() > 0.35 ? 1 : 0.3;
      hemi.intensity = sky.hemi + 2.4 * on; scene.background.copy(sky.bg).lerp(new THREE.Color("#e8eeff"), 0.6 * on);
    } else { hemi.intensity = sky.hemi; scene.background.copy(sky.bg); }
  }
}

export function follow() { if (mode === "walk") walkMode(false); mode = "follow"; }
export function explore(x, z) { if (mode === "walk") return; push.set(x, z); if (x || z) mode = "explore"; }
export const getMode = () => mode;
export function stick(x, y) { stickV.set(x, y); }
export const where = () => ({ x: +you.position.x.toFixed(2), z: +you.position.z.toFixed(2), yaw: +yaw.toFixed(2), d: +curD.toFixed(2),
  rooms: rooms.map((R) => R.id + ":" + R.f.toFixed(2)) });   // for testing
export const spots = () => ({ garage: garageWork && { x: +garageWork.pos.x.toFixed(2), z: +garageWork.pos.z.toFixed(2), yaw: +garageWork.yaw.toFixed(2) },
  derek: { x: +jar.position.x.toFixed(2), z: +jar.position.z.toFixed(2), pose: jar.userData.pose, riding: !!jar.userData.riding, bike: !!(jar.userData.bike && jar.userData.bike.visible) } });   // for testing
export function goTo(x, z, a = yaw) { if (mode !== "walk") walkMode(true); you.position.set(x, floorY(x, z), z); yaw = a; curD = camDist; }   // for testing
export function walkMode(on = mode !== "walk") {
  if (!you || !opts.full) return;
  if (on && mode !== "walk") {                    // drop in just behind Derek (or at his door), looking the way the camera looks
    const f = new THREE.Vector3(); cam.getWorldDirection(f); yaw = Math.atan2(f.x, f.z);
    const wet = groundY(jar.position.x, jar.position.z) === WATER_Y;
    const at = !jar.visible ? homeDoor : wet && beach ? beach.spot : jar.position;
    you.position.set(at.x - Math.sin(yaw) * 2.2 - Math.cos(yaw) * 0.9, 0, at.z - Math.cos(yaw) * 2.2 + Math.sin(yaw) * 0.9);   // beside + behind him
    collide(you.position); you.position.y = floorY(you.position.x, you.position.z);
    pitch = 0.2; curD = camDist; keys.clear(); push.set(0, 0);
    mode = "walk"; controls.enabled = false; you.visible = true; lens();
  } else if (!on && mode === "walk") {            // back up to the bird's-eye view, right above where you were
    mode = "explore"; you.visible = false; controls.enabled = true; drag = null; stickV.set(0, 0);
    for (const t of signs) t.visible = true;
    lens();
    controls.target.set(you.position.x, 1, you.position.z);
    cam.position.set(you.position.x - Math.sin(yaw) * 11, 9, you.position.z - Math.cos(yaw) * 11);
    controls.update();
  }
}
function lens() {                                 // wider lens at street level (much wider on a tall phone screen)
  cam.fov = mode === "walk" ? (cam.aspect < 1 ? 78 : 62) : (opts.full ? 50 : 40); cam.updateProjectionMatrix();
}
function floorY(x, z) {
  for (const b of plates) if (inBox(b, x, z)) return Y_BLOCK + (rooms.some((R) => inBox(R.box, x, z)) ? 0.03 : 0);
  return groundY(x, z);
}
function collide(p, r = 0.22) {                   // push a walker (circle) out of every bump box; stay on the island + beach
  for (let it = 0; it < 2; it++) for (const b of solids) {
    if (p.x < b.x0 - r || p.x > b.x1 + r || p.z < b.z0 - r || p.z > b.z1 + r) continue;
    const qx = Math.max(b.x0, Math.min(p.x, b.x1)), qz = Math.max(b.z0, Math.min(p.z, b.z1));
    const dx = p.x - qx, dz = p.z - qz, d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-9) { const d = Math.sqrt(d2), k = (r - d) / d; p.x += dx * k; p.z += dz * k; }
    else {
      const e = [p.x - b.x0, b.x1 - p.x, p.z - b.z0, b.z1 - p.z], m = Math.min(...e);
      if (m === e[0]) p.x = b.x0 - r; else if (m === e[1]) p.x = b.x1 + r; else if (m === e[2]) p.z = b.z0 - r; else p.z = b.z1 + r;
    }
  }
  if (jar && jar.visible) {                       // don't walk through Derek
    const dx = p.x - jar.position.x, dz = p.z - jar.position.z, d = Math.hypot(dx, dz);
    if (d < 0.45 && d > 1e-4) { p.x = jar.position.x + dx / d * 0.45; p.z = jar.position.z + dz / d * 0.45; }
  }
  if (bounds) {
    const i = bounds.isle, mx = i.w / 2 + 4.6, mz = i.d / 2 + 4.6;
    p.x = Math.max(bounds.cx - mx, Math.min(bounds.cx + mx, p.x)); p.z = Math.max(bounds.cz - mz, Math.min(bounds.cz + mz, p.z));
  }
}
const _head = new THREE.Vector3(), _back = new THREE.Vector3();
function stepWalk(dt) {
  let fwd = -stickV.y, turn = -stickV.x;
  if (keys.has("w") || keys.has("arrowup")) fwd += 1;
  if (keys.has("s") || keys.has("arrowdown")) fwd -= 1;
  if (keys.has("a") || keys.has("arrowleft")) turn += 1;
  if (keys.has("d") || keys.has("arrowright")) turn -= 1;
  fwd = Math.max(-1, Math.min(1, fwd)); turn = Math.max(-1, Math.min(1, turn));
  yaw += turn * 2.3 * dt;
  const run = keys.has("shift") || stickV.length() > 0.95 ? 1.8 : 1, sp = fwd * (fwd > 0 ? 2.6 : 1.5) * run;
  const dist = sp * dt, n = Math.max(1, Math.ceil(Math.abs(dist) / 0.12));
  for (let i = 0; i < n; i++) { you.position.x += Math.sin(yaw) * dist / n; you.position.z += Math.cos(yaw) * dist / n; collide(you.position); }
  const moving = Math.abs(sp) > 0.05, gy = floorY(you.position.x, you.position.z);
  swing += ((moving ? 1 : 0) - swing) * Math.min(1, dt * 8);
  stride += dt * Math.abs(sp) * 4.5;
  const a = Math.sin(stride) * 0.7 * swing * (sp < 0 ? -1 : 1), u = you.userData;
  u.legs[0].rotation.x = a; u.legs[1].rotation.x = -a; u.arms[0].rotation.x = -a * 0.8; u.arms[1].rotation.x = a * 0.8;
  you.position.y += (gy + Math.abs(Math.sin(stride)) * 0.04 * swing - you.position.y) * Math.min(1, dt * 18);
  you.rotation.y = yaw;
  // camera: behind you at head height; walls pull it in so it never ends up inside one
  _head.set(you.position.x, you.position.y + 1.05, you.position.z);
  const cp = Math.cos(pitch);
  _back.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  ray.set(_head, _back); ray.far = camDist + 0.3;
  const hit = ray.intersectObjects(blockers.filter((o) => !(o.userData.fr && o.userData.fr.f > 0.5)), false)[0];
  const want = hit ? Math.max(0.3, hit.distance - 0.25) : camDist;
  curD = want < curD ? want : curD + (want - curD) * Math.min(1, dt * 4);
  cam.position.copy(_head).addScaledVector(_back, curD);
  cam.position.y = Math.max(cam.position.y, floorY(cam.position.x, cam.position.z) + 0.25);
  cam.lookAt(_head.x + Math.sin(yaw) * 1.2, _head.y - 0.05, _head.z + Math.cos(yaw) * 1.2);
  you.visible = curD > 0.6;                       // so close it's first person: hide yourself
  for (const t of signs) { t.getWorldPosition(_v); t.visible = _v.distanceTo(cam.position) > 4.5; }   // name signs fill the screen up close
}
function stepRooms(dt) {                          // roof + front wall fade out while you're inside; room lamps on in walk mode
  for (const R of rooms) {
    if (!R.roof) continue;
    const inside = mode === "walk" && (inBox(R.box, you.position.x, you.position.z) || inBox(R.box, cam.position.x, cam.position.z, 0.05));
    const goal = inside ? 1 : 0;
    R.f += (goal - R.f) * Math.min(1, dt * 6); if (Math.abs(R.f - goal) < 0.01) R.f = goal;
    const op = 1 - 0.85 * R.f;
    if (R.op !== op) { R.op = op; for (const m of R.mats) { m.opacity = m.userData.op0 * op; m.depthWrite = R.f < 0.5; } }
    const sh = R.f < 0.5;
    if (sh !== R.sh) { R.sh = sh; R.fade.traverse((o) => { if (o.isMesh) o.castShadow = sh; }); }
    if (R.light) R.light.intensity = mode === "walk" ? (night ? 5 : 1.2) * (0.3 + 0.7 * R.f) : 0;
  }
}

function walk(obj, dt, speedMin, fixed = 0) {
  const path = obj.userData.path || [];
  if (!path.length) return false;
  let total = 0, prev = obj.position;
  for (const p of path) { total += p.distanceTo(prev); prev = p; }
  let step = (fixed || Math.max(speedMin, total / 2.2)) * dt;
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
  // Derek walks the roads (or rides his restored bike round the island, lap after lap)
  const riding = !!jar.userData.riding;
  if (riding && !(jar.userData.path || []).length && rideLoop) jar.userData.path = rideLoop.map((v) => v.clone());
  const moving = walk(jar, dt, 4.5, riding ? 5.5 : 0);
  const pose = riding ? "ride" : moving ? "walk" : (jar.userData.pose || "stand"), gy = floorY(jar.position.x, jar.position.z);
  if (jar.userData.bike) jar.userData.bike.visible = pose === "ride";
  jar.rotation.x = pose === "lie" ? -Math.PI / 2 : 0;
  jar.rotation.z = pose === "surf" ? Math.sin(t * 1.7) * 0.12 : 0;
  if (pose === "lie") jar.rotation.y = 0;
  if (jar.userData.board) jar.userData.board.visible = pose === "surf";
  if (jar.userData.umbrella) jar.userData.umbrella.visible = ["rain", "storm", "snow"].includes(wx.kind) && (pose === "walk" || pose === "stand");
  if (pose === "walk") jar.position.y = gy + Math.abs(Math.sin(t * 14)) * 0.08;
  else if (pose === "lie") jar.position.y = SAND_Y + 0.14;
  else if (pose === "swim") jar.position.y = WATER_Y - 0.75 + Math.sin(t * 2) * 0.05;
  else if (pose === "surf") jar.position.y = WATER_Y + 0.12 + Math.sin(t * 2.2) * 0.14;
  else if (pose === "ride") jar.position.y = groundY(jar.position.x, jar.position.z) + Math.abs(Math.sin(t * 9)) * 0.015;
  else if (pose === "work") { jar.position.y = gy + Math.abs(Math.sin(t * 5)) * 0.02; if (jar.userData.face != null) jar.rotation.y = jar.userData.face; }
  else jar.position.y = gy + Math.abs(Math.sin(t * 3)) * 0.03;
  const rough = wx.kind === "storm" ? 1.4 : wx.kind === "windy" ? 1.0 : 0.6;
  for (const w of waves) w.position.z = w.userData.z0 + Math.sin(t * (0.8 + rough * 0.3) + w.userData.z0) * rough;
  // the puppy trots after him (or naps)
  if (pup.visible) {
    const u = pup.userData;
    pup.scale.setScalar(u.ride && riding ? 0.55 : 0.9);
    if (u.ride && riding && !u.napping) {                // in the tank bag, ears flapping
      const fw = new THREE.Vector3(Math.sin(jar.rotation.y), 0, Math.cos(jar.rotation.y));
      pup.position.copy(jar.position).addScaledVector(fw, 0.2); pup.position.y += 0.44;
      pup.rotation.y = Math.atan2(-fw.z, fw.x); u.body.scale.set(1, 1, 1); u.tail.rotation.y = Math.sin(t * 20) * 0.7;
    } else if (u.napping) {
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
  for (const c of clouds) { c.position.x += dt * (wx.kind === "storm" || wx.kind === "windy" ? 2.5 : 0.6); if (bounds && c.position.x > bounds.cx + 90) c.position.x -= 180; }
  // camera: walk at ground level, follow Derek, or explore with WASD / arrows / the on-screen pad
  if (mode === "walk") stepWalk(dt);
  else if (mode === "follow") {
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
  focus.copy(mode === "walk" ? you.position : controls.target);
  stepRooms(dt);
  stepPrecip(dt, t);
  sun.position.set(focus.x + 12, 22, focus.z + 10); sun.target.position.set(focus.x, 0, focus.z);
  if (mode !== "walk") controls.update();
  R.render(scene, cam);
  if (mini && (miniT += dt) > 0.2) { miniT = 0; drawMini(); }
}

const garageKey = (G) => { const p = (G || {}).project; return JSON.stringify([p && [p.kind, p.name, p.stage, p.stages[p.stage] && p.stages[p.stage].done, p.parts, p.wait, p.colour_hex, p.finished],
  ((G || {}).bikes || []).map((b) => b.name + b.colour_hex)]); };
const etHour = (iso) => Number(new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })) % 24;

export function update(state, town) {
  if (!ready || !town) return;
  lastState = { state, town };
  wx = state.weather || {};
  const hr = etHour(state.updated);
  night = hr < 6 || hr >= 20;
  const lucky = state.lucky || {}, luckyLive = !(lucky.date === (state.stats.today || {}).date && lucky.used >= lucky.max);
  const key = JSON.stringify([town.lots.map((l) => [l.lot, l.id]), town.site && [town.site.lot, town.site.done], town.max_lots, night, luckyLive,
                             ((state.beach && state.beach.castles) || []).map((c) => c.size), (state.owned || []).join(), (state.pup || {}).name || "",
                             wx.kind, wx.season, Math.round((wx.snow || 0) * 4), (wx.wet || 0) >= 0.35, wx.snowman || 0, garageKey(state.garage)]);
  const first = !lastKey;
  if (key !== lastKey) { rebuild(town, luckyLive); lastKey = key; }
  if (jarFill) jarFill.scale.y = Math.max(0.03, Math.min(1, (state.coins || 0) / (state.coins_goal || 1)));
  const doing = String(state.doing || "").toLowerCase();
  let pose = "stand", goal = (places[state.place] || homeDoor).clone();
  if (state.place === "beach" && beach && !state.asleep) {
    if (doing.includes("surf")) { goal = beach.surf.clone(); pose = "surf"; }
    else if (doing.includes("swim")) { goal = beach.swim.clone(); pose = "swim"; }
    else if (doing.includes("tan")) { goal = beach.towel.clone(); pose = "lie"; }
    else if (doing.includes("sand castle")) goal = beach.castle.clone().add(new THREE.Vector3(-1.3, 0, 0.3));
  }
  const G = state.garage || {}, gp = G.project;
  if (!state.asleep && state.place === "garage" && garageWork && doing.startsWith("restoring")) { goal = garageWork.pos.clone(); pose = "work"; }
  jar.userData.face = pose === "work" ? garageWork.yaw : null;
  const rb = !state.asleep && state.place === "garage" && doing.startsWith("riding") && rideLoop ? (gp && gp.finished ? gp : (G.bikes || []).slice(-1)[0]) : null;
  if (rb) pose = "ride";
  const rk = rb ? [rb.colour_hex, rb.look || rb.kind].join() : "";
  if (rk !== rideKey) {                               // the bike he rides, in her real colours
    rideKey = rk;
    if (jar.userData.bike) jar.remove(jar.userData.bike);
    jar.userData.bike = null;
    if (rb) { const adv = (rb.look || "") === "adventure"; jar.userData.bike = bikeModel({ adv, paint: rb.colour_hex || "#8b2b1f", shiny: true, racks: adv, boxes: adv }); jar.userData.bike.visible = false; jar.add(jar.userData.bike); }
  }
  jar.userData.pose = pose;
  if (jar.userData.skin) jar.userData.skin.color.set("#e9c39b").lerp(new THREE.Color("#a8683c"), Math.min(1, (state.beach && state.beach.tan) || 0));
  if (first) {   // start next to him
    jar.position.copy(goal); pup.position.copy(groundY(goal.x, goal.z) === WATER_Y && beach ? new THREE.Vector3(goal.x, SAND_Y, beach.edge) : goal).add(new THREE.Vector3(-0.8, 0, 0.4));
    controls.target.set(goal.x, 1, goal.z); cam.position.set(goal.x + (opts.full ? 9 : 7), opts.full ? 9 : 8, goal.z + (opts.full ? 15 : 12));
    jar.userData.path = [];
    jar.userData.riding = pose === "ride";
    if (pose === "ride") { jar.position.copy(rideLoop[0]); jar.userData.path = rideLoop.map((v) => v.clone()); }
  } else if (pose === "ride") {
    if (!jar.userData.riding) { jar.userData.riding = true; jar.userData.path = [...pathTo(jar.position, rideLoop[0]), ...rideLoop.map((v) => v.clone())]; }
  } else if (jar.userData.riding || !jar.userData.goal || jar.userData.goal.distanceTo(goal) > 0.1) {
    jar.userData.riding = false;
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
    pup.userData.ride = (p.learned || []).includes("ride");
    if (state.asleep && first) pup.position.copy(homeDoor).add(new THREE.Vector3(-0.6, 0, 0));
  }
}
