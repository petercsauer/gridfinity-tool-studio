// Gridfinity Tool Studio UI: inspector controls, the 2D trace and the 3D preview.
// All processing runs in the pipeline worker (src/worker/).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { binSize, bounds, maxDepth, type Vec2 } from './geometry/pocket';
import { normalizeDeg, placeRing, type Layout, type Placement } from './kit';
import { hitTest, LayoutView, lockedCells, turnAbout } from './layout-view';
import { clampParams, DEFAULTS, MAX_CELLS, type Params } from './params';
import { loadUploads, removeUpload, saveLayout, saveUpload, touchUpload, type StoredUpload } from './storage';
import { count, uploadErrorEvent } from './count';
import { writeStl } from './stl';
import { traceDxf, traceSvg, type TraceLayers } from './trace-export';
import { isDark, TraceView } from './trace';
import { OutlineView } from './outline-view';
import { decodePhoto } from './vision/decode';
import { modelCached } from './vision/model';
import { centroid } from './vision/symmetry';
import { PipelineClient } from './worker/client';
import {
  PipelineError, type BuildResult, type OutlineResult, type Progress, type ToolInfo, type UploadResult,
} from './worker/protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const errorText = (e: unknown) => (e instanceof PipelineError ? e.message : `Something went wrong: ${String(e)}`);

const client = new PipelineClient(
  new Worker(new URL('./worker/pipeline.worker.ts', import.meta.url), { type: 'module' }));
void client.request('configure', { assetBase: document.baseURI });

/** The inspector's values, clamped to the allowed ranges. */
function state(): Params {
  return clampParams({
    tool: $<HTMLSelectElement>('tool').value,
    sym: input('sym').checked,
    clearance: +input('clearance').value,
    rot: +input('rot').value,
    slotOn: input('slotOn').checked,
    slotR: +input('slotD').value / 2,
    slotOver: DEFAULTS.slotOver,
    slotFrac: +input('slotFrac').value,
    u: +input('u').value,
    depth: +input('depth').value,
    fillet: +input('fillet').value,
    bfillet: +input('bfillet').value,
    holes: $<HTMLSelectElement>('holes').value as Params['holes'],
    holesCorners: input('holesCorners').checked,
    lip: input('lip').checked,
    halfGrid: input('halfGrid').checked,
  });
}

// ---- tools: the presets, then the user's uploads (kept in IndexedDB, see storage.ts)
let tools: ToolInfo[] = [];
const toolMenu = $<HTMLSelectElement>('tool');
const uploadGroup = document.createElement('optgroup');
uploadGroup.label = 'Your uploads';
/** Object URLs of the uploads' sheet images, by tool id. */
const sheetUrls = new Map<string, string>();
function addToolOption(t: ToolInfo, parent: HTMLElement = toolMenu): void {
  const o = document.createElement('option');
  o.value = t.id;
  o.textContent = t.label;
  parent.appendChild(o);
}
const isUpload = (id: string) => sheetUrls.has(id);
/** Make an upload selectable: register it with the worker and add it to the menu. */
function addUploadTool(u: UploadResult & Pick<StoredUpload, 'layout'>): void {
  if (u.layout) layouts.set(u.id, u.layout);
  const sheetImage = URL.createObjectURL(u.sheetViewJpeg);
  sheetUrls.set(u.id, sheetImage);
  const { id, label, sym, parts, sheetBox } = u;
  void client.request('addTool', { tool: { id, label, sym, parts, sheetBox, sheetImage } });
  tools.push({ id: u.id, label: u.label, sym: u.sym });
  addToolOption(u, uploadGroup);
  if (!uploadGroup.isConnected) toolMenu.appendChild(uploadGroup);
}
function dropUploadTool(id: string): void {
  void client.request('removeTool', { id });
  layouts.delete(id);
  URL.revokeObjectURL(sheetUrls.get(id) ?? '');
  sheetUrls.delete(id);
  tools = tools.filter((t) => t.id !== id);
  [...uploadGroup.children].find((o) => (o as HTMLOptionElement).value === id)?.remove();
  if (!uploadGroup.children.length) uploadGroup.remove();
}

// ---- 2D trace: clicking a part of a kit selects it, as in the Layout pane
const trace = new TraceView($<HTMLCanvasElement>('flat'), (pt) => {
  const r = outlineNow();
  const l = currentLayout();
  if (!r || !l || r.parts.length < 2) return;
  const vis = l.placements.filter((pl) => !pl.hidden);
  const i = hitTest(pt, vis.map((pl) => r.parts.find((q) => q.id === pl.part)?.sheetPocket ?? []));
  layoutView.select(i === null ? null : vis[i]!.part);
});

// ---- layout: where each tool's parts sit in the bin and their pocket settings, once the user has arranged
// or set them (else the kit's initial layout, which the worker makes from the inspector's values).
const layouts = new Map<string, Layout>();
/** The latest outline, for the tool it was made for. */
let lastOutline: OutlineResult | null = null;
let lastOutlineTool = '';
/** Each placement's cut depth in the latest bin (0 for hidden ones), for the tool it was built for. */
let lastDepths: { tool: string; depths: number[] } | null = null;
/** Uploads remember their layout; saved 500 ms after the last change to it. */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingSaves = new Map<string, Layout>();
function queueSave(id: string, layout: Layout): void {
  clearTimeout(saveTimers.get(id));
  pendingSaves.set(id, layout);
  saveTimers.set(id, setTimeout(() => flushSave(id), 500));
}
function flushSave(id: string): void {
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  const l = pendingSaves.get(id);
  pendingSaves.delete(id);
  if (l) void saveLayout(id, l).catch(() => {});
}
// the last half second of changes isn't lost when the page is hidden or closed
const flushSaves = () => [...pendingSaves.keys()].forEach(flushSave);
addEventListener('pagehide', flushSaves);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSaves();
});
function setLayout(id: string, layout: Layout): void {
  layouts.set(id, layout);
  if (isUpload(id)) queueSave(id, layout);
}
/** The current tool's outline, if the latest one is for it. */
const outlineNow = () => (lastOutline && lastOutlineTool === toolMenu.value ? lastOutline : null);
/** The current tool's layout: the user's, or the one its latest outline was made for. */
const currentLayout = () => layouts.get(toolMenu.value) ?? outlineNow()?.layout;
/** The selected part's placement in `l`, if it is visible there. */
const selectedIn = (l: Layout) => l.placements.find((pl) => pl.part === layoutView.selection && !pl.hidden);
/** The placements the per-part controls show and edit: the selected part, else every visible one. */
function scope(l: Layout): Placement[] {
  const sel = selectedIn(l);
  return sel ? [sel] : l.placements.filter((pl) => !pl.hidden);
}
/** The layout before the control being moved was first touched: one undo step per gesture. */
let gestureStart: Layout | null = null;
/** Apply a per-part control to the placements in scope. A tool the user hasn't laid out yet takes the
 * inspector's values for all its parts in its initial layout, so it gets a layout of its own only when some
 * parts are to differ (or `own`). */
function editParts(fn: (pl: Placement) => Placement, own = false): void {
  const id = toolMenu.value;
  const l = currentLayout();
  if (!l || (!layouts.has(id) && !own && !selectedIn(l))) {
    changed();
    return;
  }
  gestureStart ??= l;
  const ids = new Set(scope(l).map((pl) => pl.part));
  const next = { ...l, placements: l.placements.map((pl) => (ids.has(pl.part) ? fn(pl) : pl)) };
  setLayout(id, next);
  layoutView.preview(next);
  changed();
}
/** A control was let go: its edits become one undo step. */
function endGesture(): void {
  const l = layouts.get(toolMenu.value);
  const start = gestureStart;
  gestureStart = null;
  if (start && l && l !== start) layoutView.apply(l, start);
}
const layoutView = new LayoutView($<HTMLCanvasElement>('plan'), $('partList'), $('layoutStatus'), $('layoutWarnings'), {
  change(layout, id) {
    gestureStart = null;
    setLayout(id, layout);
    syncInspector();
    // the Outline pane shows the part's path from the layout at once (an undo there needn't wait for the worker)
    syncOutline();
    changed();
  },
  live({ nx, ny, w, h }) {
    $('cells').textContent = `${nx}×${ny}`;
    $('pdim').textContent = `${w.toFixed(1)}×${h.toFixed(1)} mm`;
    $('bdim').textContent = `${binSize(nx).toFixed(0)}×${binSize(ny).toFixed(0)}×${(state().u * 7).toFixed(0)} mm`;
  },
  select(id) {
    trace.select(id);
    syncInspector();
    syncOutline();
  },
});

// ---- the flat pane: Layout or Trace. Kits with several parts open in Layout, single tools in Trace.
const tabs = { layout: $('tabLayout'), trace: $('tabTrace'), outline: $('tabOutline') };
function showPane(name: keyof typeof tabs): void {
  for (const [k, tab] of Object.entries(tabs)) {
    const on = k === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(tab.getAttribute('aria-controls')!).hidden = !on;
  }
  if (name === 'layout') layoutView.draw();
  else if (name === 'trace') trace.draw();
  else {
    // the outline is edited one part at a time: the selected one, else the first
    const l = currentLayout();
    if (!layoutView.selection && l) layoutView.select(l.placements.find((pl) => !pl.hidden)?.part ?? null);
    syncOutline();
  }
}
const tabOrder = Object.keys(tabs) as (keyof typeof tabs)[];
/** The tool the pane was last chosen for, by the app (on the tool's first outline) or the user; the choice
 * holds until the tool changes. */
let paneTool = '';
/** The user picked a pane: it holds for this tool, even if its first outline comes back after. */
function pickPane(name: keyof typeof tabs): void {
  paneTool = toolMenu.value;
  showPane(name);
}
for (const [k, tab] of Object.entries(tabs) as [keyof typeof tabs, HTMLElement][]) {
  tab.addEventListener('click', () => pickPane(k));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = tabOrder[(tabOrder.indexOf(k) + (e.key === 'ArrowRight' ? 1 : tabOrder.length - 1)) % tabOrder.length]!;
    pickPane(next);
    tabs[next].focus();
    e.preventDefault();
  });
}

// ---- the Outline pane: the selected part's outline, editable. An edit is the part's `path` in the layout, so
// it is saved, undone and sent to the worker like any other layout change.
const outlineParts = $('outlineParts');
const outlineView = new OutlineView($<HTMLCanvasElement>('outlineCanvas'), {
  detail: input('outlineDetail'), detailValue: $('outlineDetailV'), count: $('outlineCount'), status: $('outlineStatus'),
  kind: $<HTMLButtonElement>('outlineKind'), straighten: $<HTMLButtonElement>('outlineStraight'),
  remove: $<HTMLButtonElement>('outlineRemove'), reset: $<HTMLButtonElement>('outlineReset'),
  round: $<HTMLButtonElement>('outlineRound'), radius: input('outlineRadius'),
}, {
  change(path) {
    const l = currentLayout();
    const id = outlinePart();
    if (!l || !id) return;
    const next = {
      ...l,
      placements: l.placements.map((pl) => {
        if (pl.part !== id) return pl;
        const { path: _old, ...rest } = pl;
        return path ? { ...rest, path } : rest;
      }),
    };
    layoutView.apply(next, l);
  },
  undo(redo) {
    layoutView.history(redo);
  },
});
/** The part the Outline pane edits: the selected one, else the first visible one. */
function outlinePart(): string | null {
  const l = currentLayout();
  return layoutView.selection ?? l?.placements.find((pl) => !pl.hidden)?.part ?? null;
}
function syncOutline(): void {
  const r = outlineNow();
  const l = currentLayout();
  const id = outlinePart();
  const part = r?.parts.find((q) => q.id === id);
  const pl = l?.placements.find((q) => q.part === id);
  const vis = l?.placements.filter((q) => !q.hidden) ?? [];
  const num = (pid: string) => (l?.placements.findIndex((q) => q.part === pid) ?? -1) + 1;
  // the part chooser, for kits
  outlineParts.hidden = vis.length < 2;
  outlineParts.replaceChildren(...vis.map((q) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.part = q.part;
    li.textContent = `Part ${num(q.part)}`;
    li.setAttribute('aria-selected', String(q.part === id));
    li.tabIndex = q.part === id ? 0 : -1;
    return li;
  }));
  outlineView.show(r && part && pl && id ? {
    tool: toolMenu.value, part, placement: pl, label: `Part ${num(id)}`, sheetImage: r.sheetImage, sheetBox: r.sheetBox,
  } : null);
}
outlineParts.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('[role=option]');
  if (li) layoutView.select(li.dataset.part!);
});
outlineParts.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const items = [...outlineParts.querySelectorAll<HTMLElement>('[role=option]')];
  const i = items.findIndex((li) => li.getAttribute('aria-selected') === 'true');
  const next = items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
  if (next) {
    layoutView.select(next.dataset.part!);
    outlineParts.querySelector<HTMLElement>(`[data-part="${CSS.escape(next.dataset.part!)}"]`)?.focus();
  }
  e.preventDefault();
});

// ---- 3D view (Quick Look product shot)
// Vertex normals for the (non-indexed) bin mesh. Two stages:
// 1. Creased, area-weighted normals: faces meeting at a position are clustered by normal (within `angle` of
//    the cluster's seed), so rim and floor edges stay crisp while curved walls shade smoothly.
// 2. The pocket's top fillet is built as 0.2 mm terraces (vertical risers + flat ledges). Shaded per facet,
//    those terraces alias into "fur". For corners of small faces (every edge < 1 mm) the normal is instead
//    averaged over all small faces within `r` mm, which renders the terraces as the fillet they approximate.
// Linear time (spatial hash), unlike BufferGeometryUtils.toCreasedNormals, which is quadratic on triangle
// fans and stalls on bins this size.
function binNormals(geo: THREE.BufferGeometry, angle: number, r = 0.6): THREE.BufferGeometry {
  const P = geo.attributes.position!.array as Float32Array;
  const n = P.length / 3;
  const cosA = Math.cos(angle);
  const cosS = Math.cos((75 * Math.PI) / 180);
  const posId = new Map<string, number>();
  const px: number[] = [], py: number[] = [], pz: number[] = [];
  const cl: number[][] = []; // unique positions, and their cluster ids
  const seed: number[] = [], sum: number[] = [];
  const corner = new Int32Array(n), cpos = new Int32Array(n);
  const small = new Uint8Array(n / 3), fu = new Float32Array(n); // per face: all edges < 1 mm; unit normal at fu[3F..3F+2]
  const S0 = new Map<number, [number, number, number]>(); // posId -> summed small-face normals
  for (let f = 0; f < n; f += 3) {
    const i = f * 3;
    const ax = P[i]!, ay = P[i + 1]!, az = P[i + 2]!, bx = P[i + 3]!, by = P[i + 4]!, bz = P[i + 5]!;
    const cx = P[i + 6]!, cy = P[i + 7]!, cz = P[i + 8]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const wx = cx - bx, wy = cy - by, wz = cz - bz;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz); // |n| = 2*area
    const F = f / 3;
    const isSmall = len > 1e-12 && Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz) < 1;
    small[F] = isSmall ? 1 : 0;
    if (len > 1e-12) { fu[f] = nx / len; fu[f + 1] = ny / len; fu[f + 2] = nz / len; }
    for (let k = 0; k < 3; k++) {
      const j = i + k * 3;
      const key = Math.round(P[j]! * 1e3) + ',' + Math.round(P[j + 1]! * 1e3) + ',' + Math.round(P[j + 2]! * 1e3);
      let pid = posId.get(key);
      if (pid === undefined) { pid = px.length; posId.set(key, pid); px.push(P[j]!); py.push(P[j + 1]!); pz.push(P[j + 2]!); cl.push([]); }
      cpos[f + k] = pid;
      const list = cl[pid]!;
      let cid = -1;
      if (len > 1e-12) {
        for (const c of list) { const q = c * 3; if ((seed[q]! * nx + seed[q + 1]! * ny + seed[q + 2]! * nz) / len >= cosA) { cid = c; break; } }
      } else if (list.length) cid = list[0]!;
      if (cid < 0) {
        cid = seed.length / 3; list.push(cid);
        if (len > 1e-12) seed.push(nx / len, ny / len, nz / len); else seed.push(0, 0, 1);
        sum.push(0, 0, 0);
      }
      const q = cid * 3; sum[q]! += nx; sum[q + 1]! += ny; sum[q + 2]! += nz; corner[f + k] = cid;
      if (isSmall) { let a = S0.get(pid); if (!a) { a = [0, 0, 0]; S0.set(pid, a); } a[0] += nx; a[1] += ny; a[2] += nz; }
    }
  }
  // stage 2: smooth small-face normals over a radius (spatial hash with cell = r)
  const cell = (k: number) => Math.floor(k / r);
  const grid = new Map<string, number[]>(), S = new Map<number, [number, number, number]>();
  for (const pid of S0.keys()) {
    const g = cell(px[pid]!) + ',' + cell(py[pid]!) + ',' + cell(pz[pid]!);
    let b = grid.get(g); if (!b) { b = []; grid.set(g, b); } b.push(pid);
  }
  for (const pid of S0.keys()) {
    const gx = cell(px[pid]!), gy = cell(py[pid]!), gz = cell(pz[pid]!);
    let x = 0, y = 0, z = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const bucket = grid.get((gx + a) + ',' + (gy + b) + ',' + (gz + c)); if (!bucket) continue;
      for (const o of bucket) {
        const d = Math.hypot(px[o]! - px[pid]!, py[o]! - py[pid]!, pz[o]! - pz[pid]!); if (d >= r) continue;
        const w = 1 - d / r, s0 = S0.get(o)!; x += s0[0] * w; y += s0[1] * w; z += s0[2] * w;
      }
    }
    const l = Math.hypot(x, y, z); if (l > 0) S.set(pid, [x / l, y / l, z / l]);
  }
  const N = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const f = v - (v % 3), sm = small[f / 3] ? S.get(cpos[v]!) : undefined;
    if (sm && sm[0] * fu[f]! + sm[1] * fu[f + 1]! + sm[2] * fu[f + 2]! >= cosS) { N[v * 3] = sm[0]; N[v * 3 + 1] = sm[1]; N[v * 3 + 2] = sm[2]; continue; }
    const q = corner[v]! * 3, x = sum[q]!, y = sum[q + 1]!, z = sum[q + 2]!, l = Math.hypot(x, y, z) || 1;
    N[v * 3] = x / l; N[v * 3 + 1] = y / l; N[v * 3 + 2] = z / l;
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  return geo;
}

const tc = $<HTMLCanvasElement>('three');
const renderer = new THREE.WebGLRenderer({ canvas: tc, antialias: true, alpha: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.background = null;
const fog = new THREE.Fog(0xefeff1, 1, 1); // fades the floor grid into the backdrop; near/far set per mesh
scene.fog = fog;
// studio environment is built lazily with the first mesh, so first paint (trace + backdrop) isn't blocked
const ensureEnv = () => {
  scene.environment ??= new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
};
const cam = new THREE.PerspectiveCamera(30, 1, 1, 5000);
cam.position.set(180, 180, 220);
const controls = new OrbitControls(cam, tc);
controls.enableDamping = true;
controls.dampingFactor = reduceMotion ? 1 : 0.08;
controls.rotateSpeed = 0.8;
controls.zoomSpeed = 0.9;
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI; // free orbit, so the underside stays inspectable
controls.screenSpacePanning = true;
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(40, 200, 60);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.radius = 8;
key.shadow.bias = -0.0005;
scene.add(key);
scene.add(key.target);
const floorLight = new THREE.HemisphereLight(0xffffff, 0x202022, 0); // dark mode only
scene.add(floorLight);
const groundMat = new THREE.ShadowMaterial({ opacity: 0.16 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.3;
ground.receiveShadow = true;
scene.add(ground);
// soft contact shadow (canvas radial texture) under the bin, scaled to its footprint in showMesh
const contactMat = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, 'rgba(0,0,0,.55)');
  r.addColorStop(0.6, 'rgba(0,0,0,.25)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false });
})();
const contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), contactMat);
contact.rotation.x = -Math.PI / 2;
contact.position.y = -0.25;
contact.renderOrder = 1;
contact.visible = false;
scene.add(contact);
const grid = new THREE.GridHelper(42 * 12, 12, 0x000000, 0x000000);
const gridMat = grid.material as THREE.LineBasicMaterial;
gridMat.transparent = true;
gridMat.opacity = 0.1;
gridMat.depthWrite = false;
grid.position.y = -0.2;
scene.add(grid);
let mesh: THREE.Mesh | null = null;
const mat = new THREE.MeshStandardMaterial({ color: 0x1287ff, metalness: 0, roughness: 0.5, flatShading: false });
mat.envMapIntensity = 0.8;
mat.fog = false;
groundMat.fog = false;
contactMat.fog = false;
gridMat.fog = true;
function applyTheme3D(): void {
  const d = isDark();
  mat.color.set(d ? 0x1a8cff : 0x1287ff); // electric blue, like a spool of PLA
  groundMat.opacity = d ? 0.35 : 0.16;
  contactMat.opacity = d ? 1 : 0.85;
  gridMat.color.set(d ? 0xffffff : 0x000000);
  gridMat.opacity = d ? 0.07 : 0.08;
  floorLight.intensity = d ? 0.25 : 0;
  fog.color.set(d ? 0x1c1c1e : 0xefeff1);
}
applyTheme3D();
function size3(): void {
  const r = tc.parentElement!.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  cam.aspect = r.width / r.height;
  cam.updateProjectionMatrix();
}
// Quick Look framing: first load, tool change, or double-click on the preview
let needFrame = true;
let lastFit: { R: number; c: THREE.Vector3 } | null = null;
function frameView(): void {
  if (!lastFit) return;
  const { R, c } = lastFit;
  size3(); // aspect must be current; fit to the narrower of the vertical/horizontal fov
  const vHalf = ((cam.fov / 2) * Math.PI) / 180;
  const hHalf = Math.atan(Math.tan(vHalf) * cam.aspect);
  const dist = (R / Math.sin(Math.min(vHalf, hHalf))) * 1.15;
  const dir = new THREE.Vector3(1.6, 1.5, 1.9).normalize();
  cam.position.copy(c).addScaledVector(dir, dist);
  controls.target.copy(c);
  controls.update();
  fog.near = dist * 0.8;
  fog.far = dist * 1.6;
  cam.near = dist * 0.05;
  cam.far = dist * 30;
  cam.updateProjectionMatrix(); // tight depth range: no z-fighting on the pocket walls
}
/** Show a built bin (mm, Z up) on the ground plane. */
function showMesh(bin: BuildResult): void {
  ensureEnv();
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.BufferAttribute(bin.positions, 3));
  indexed.setIndex(new THREE.BufferAttribute(bin.indices, 1));
  const geo = binNormals(indexed.toNonIndexed(), Math.PI / 5); // smooth curved walls + terraced fillet, keep rim/floor creases crisp
  indexed.dispose();
  geo.center();
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
  }
  mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.castShadow = true;
  scene.add(mesh);
  geo.computeBoundingSphere();
  const R = geo.boundingSphere!.radius;
  // sit the bin on the ground + baseplate grid
  const box = new THREE.Box3().setFromObject(mesh);
  const c = box.getCenter(new THREE.Vector3());
  grid.position.y = box.min.y - 0.1;
  ground.position.y = box.min.y - 0.15;
  const sz = box.getSize(new THREE.Vector3());
  contact.position.set(c.x, box.min.y - 0.12, c.z);
  contact.scale.set(sz.x * 1.45, sz.z * 1.45, 1);
  // fit the shadow camera to 1.5x the footprint
  const sc = key.shadow.camera;
  const ext = R * 1.5;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = R * 8;
  sc.updateProjectionMatrix();
  key.position.set(c.x + R * 0.4, c.y + R * 2, c.z + R * 0.6);
  key.target.position.copy(c);
  lastFit = { R, c };
  if (needFrame) {
    frameView(); // keep the user's orbit/zoom on ordinary rebuilds
    needFrame = false;
  }
}
tc.addEventListener('dblclick', frameView);
(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  size3();
  const below = cam.position.y < ground.position.y; // looking at the underside: drop the floor
  ground.visible = grid.visible = !below;
  contact.visible = !below && !!mesh;
  renderer.render(scene, cam);
})();

// ---- pipeline actions
const previewMsg = $('previewMsg');
const spin = $('spin');

// ---- export: only ever the bin for the current settings
/** Bumped on every settings change; a mesh is current when it was built for this version. */
let currentVersion = 0;
let shown: { version: number; tool: string; bin: BuildResult } | null = null;
/** Export was clicked while the bin was out of date: save as soon as the current one is ready. */
let exportWanted = false;
const expBtn = $<HTMLButtonElement>('exp');
const expLabel = [...expBtn.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())!;
/** The current bin, or null while it is being rebuilt (or can't be built). */
const exportable = () => (shown && shown.version === currentVersion ? shown : null);
/** The settings version that can't produce a bin (too large, or the build failed). */
let blockedVersion = -1;
function syncExport(): void {
  const buildBlocked = blockedVersion === currentVersion;
  const updating = !exportable() && !buildBlocked;
  expBtn.disabled = buildBlocked || (updating && exportWanted);
  expLabel.textContent = updating ? ' Updating…' : ' Export STL';
  expBtn.setAttribute('aria-busy', String(updating));
  if (buildBlocked) exportWanted = false;
  if (exportWanted && exportable()) {
    exportWanted = false;
    saveStl();
    syncExport();
  }
}
function saveStl(): void {
  const cur = exportable();
  if (!cur) return;
  count('export-stl');
  download(new Blob([writeStl(cur.bin.positions, cur.bin.indices)], { type: 'model/stl' }), `gridfinity_${cur.tool}.stl`);
}
expBtn.addEventListener('click', () => {
  exportWanted = true;
  syncExport();
});
/** Footprint of the latest outline; builds are skipped while it is over the limit. */
let tooLarge = false;
/** The latest outline refresh; a build waits for it so it sees the current footprint. */
let pendingOutline: Promise<void> = Promise.resolve();

// ---- trace export: the current outlines and pockets as SVG or DXF (1:1 mm), as arranged in the bin
let lastTrace: { tool: string; layers: TraceLayers } | null = null;
/** The visible parts' tools and pockets where the layout puts them. A kit with several parts is exported in
 * bin coordinates (the bin centred on the origin, as built) with its parts' ids and the bin's outline; a single
 * tool as it always was. */
function traceLayers(r: OutlineResult): TraceLayers {
  const vis = r.layout.placements.flatMap((pl) => {
    const q = r.parts.find((t) => t.id === pl.part);
    return q && !pl.hidden ? [{ pl, q }] : [];
  });
  const tools = vis.map(({ pl, q }) => placeRing(q.tool, pl));
  const pockets = vis.map(({ pl, q }) => placeRing(q.pocket, pl));
  if (r.layout.placements.length < 2) return { tools, pockets };
  // an auto-sized bin is centred on its pockets; a locked one on the placements' origin
  const b = bounds(pockets.flat());
  const [cx, cy] = r.layout.cells ? [0, 0] : [(b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2];
  const move = (P: Vec2[]) => P.map(([x, y]): Vec2 => [x - cx, y - cy]);
  return {
    tools: tools.map(move), pockets: pockets.map(move), ids: vis.map(({ pl }) => pl.part),
    bin: { w: binSize(r.nx), h: binSize(r.ny) },
  };
}
function syncTraceExport(): void {
  for (const id of ['expSvg', 'expDxf']) $<HTMLButtonElement>(id).disabled = !lastTrace;
}
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a); // Safari ignores clicks on detached anchors
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}
async function saveTrace(kind: 'svg' | 'dxf'): Promise<void> {
  await pendingOutline; // the outline for the latest settings
  if (!lastTrace) return;
  const label = toolMenu.selectedOptions[0]?.textContent ?? lastTrace.tool;
  const base = `trace_${lastTrace.tool}`;
  count(kind === 'svg' ? 'export-svg' : 'export-dxf');
  if (kind === 'svg') download(new Blob([traceSvg(lastTrace.layers, label)], { type: 'image/svg+xml' }), `${base}.svg`);
  else download(new Blob([traceDxf(lastTrace.layers)], { type: 'application/dxf' }), `${base}.dxf`);
}
$('expSvg').addEventListener('click', () => void saveTrace('svg'));
$('expDxf').addEventListener('click', () => void saveTrace('dxf'));

/** Below this mirror IoU, "Symmetric tool" warns that the pocket will be wider than the tool. */
const SYMMETRIC_SCORE = 0.92;

async function refreshOutline(): Promise<void> {
  const p = state();
  let r;
  try {
    r = await client.request('outline', { params: p, layout: layouts.get(p.tool) });
  } catch (e) {
    previewMsg.textContent = errorText(e);
    return;
  }
  if (!r) return; // superseded by a newer change
  lastOutline = r;
  lastOutlineTool = p.tool;
  $('cells').textContent = `${r.nx}×${r.ny}`; // half cells show as 1.5, 2.5…
  $('pdim').textContent = `${r.w}×${r.h} mm`;
  $('bdim').textContent = `${binSize(r.nx).toFixed(0)}×${binSize(r.ny).toFixed(0)}×${(p.u * 7).toFixed(0)} mm`;
  tooLarge = r.nx > MAX_CELLS || r.ny > MAX_CELLS;
  if (tooLarge) {
    previewMsg.textContent = `This tool needs a ${r.nx}×${r.ny} bin; the largest is ${MAX_CELLS}×${MAX_CELLS}. ` +
      'Try a smaller rotation or clearance.';
  }
  layoutView.show({
    id: p.tool, parts: r.parts, layout: layouts.get(p.tool) ?? r.layout, fillet: p.fillet, halfGrid: p.halfGrid,
    warnings: r.warnings ?? [],
  });
  trace.select(layoutView.selection);
  trace.show(r);
  syncInspector();
  syncOutline();
  if (paneTool !== p.tool) {
    paneTool = p.tool;
    showPane(r.parts.length > 1 ? 'layout' : 'trace');
  }
  lastTrace = { tool: p.tool, layers: traceLayers(r) };
  syncTraceExport();
}

let busy = false;
let again = false;
async function generate(): Promise<void> {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  spin.style.display = 'grid';
  let version = currentVersion;
  try {
    await pendingOutline;
    version = currentVersion;
    if (tooLarge) blockedVersion = version;
    else {
      const params = state();
      const r = await client.request('build', { params, layout: layouts.get(params.tool) });
      if (r) {
        showMesh(r);
        shown = { version, tool: params.tool, bin: r };
        lastDepths = { tool: params.tool, depths: r.effectiveDepths ?? [] };
        syncDepth();
        previewMsg.textContent = '';
      }
    }
  } catch (e) {
    blockedVersion = version;
    previewMsg.textContent = errorText(e);
  }
  syncExport();
  busy = false;
  spin.style.display = 'none';
  if (again) {
    again = false; // coalesce changes made while busy
    void generate();
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let h: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(h);
    h = setTimeout(fn, ms);
  };
}
const dOutline = debounce(() => { pendingOutline = refreshOutline(); }, 100);
const dGenerate = debounce(() => void generate(), 400);
function changed(): void {
  currentVersion++;
  syncExport();
  dOutline();
  dGenerate();
}

// ---- value labels, slider fill and wiring
const trim = (v: number) => String(+v.toFixed(2)); // 2.5, 10, 3.25, 0
const syncP = (el: HTMLInputElement) => {
  const v = +el.value, mn = +el.min, mx = +el.max;
  el.style.setProperty('--p', (mx > mn ? ((v - mn) / (mx - mn)) * 100 : 0) + '%');
};
/** "Mixed": the parts a per-part control edits differ, so it shows a dimmed thumb (or knob) and no value. */
const isMixed = (el: HTMLInputElement) => el.closest('.row')!.classList.contains('mixed');
function setMixed(el: HTMLInputElement, on: boolean): void {
  el.closest('.row')!.classList.toggle('mixed', on);
  el.classList.toggle('mixed', on);
  if (on && el.type === 'range') el.setAttribute('aria-valuetext', 'Mixed');
  else el.removeAttribute('aria-valuetext');
}
/** "1", "1 and 2", "1, 2 and 3". */
const andList = (ns: number[]) => (ns.length < 2 ? String(ns[0] ?? '') : `${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}`);
/** Depth slider: capped to the deepest pocket the current height allows, showing the depth that will be cut
 * (or "Mixed"); for kits with several parts the note lists the depth each part was cut to. */
function syncDepth(): void {
  const el = input('depth');
  const p = state();
  const u = p.u;
  const deepest = maxDepth(u, p);
  const min = Math.min(3, deepest);
  el.min = String(min);
  el.max = String(min + Math.ceil((deepest - min) / 0.5) * 0.5); // step-aligned, so the slider can reach `deepest`
  el.disabled = deepest <= 0;
  el.value = String(Math.min(+el.value, +el.max));
  $('depthV').textContent = isMixed(el) ? 'Mixed' : trim(Math.min(+el.value, deepest));
  const note = $('depthNote');
  let text = deepest > 0
    ? `Deepest pocket at ${u}U: ${trim(deepest)} mm.`
    : `A ${u}U bin is too short for a pocket. Use 2U or taller.`;
  const l = currentLayout();
  const cut = lastDepths?.tool === toolMenu.value ? lastDepths.depths : [];
  if (deepest > 0 && l && l.placements.length > 1 && cut.length === l.placements.length) {
    text += ` Cut depths: ${l.placements.flatMap((pl, i) => (pl.hidden ? [] : [`part ${i + 1} ${trim(cut[i]!)} mm`])).join(', ')}.`;
  }
  note.textContent = text;
  note.classList.toggle('warn', deepest <= 0);
  syncP(el);
}
/** A slider's value for the placements it shows: theirs, or "Mixed" when they differ. */
function showRange(id: string, values: number[], fmt: (v: number) => string): void {
  const el = input(id);
  const mixed = values.some((v) => v !== values[0]);
  el.value = String(values[0]);
  setMixed(el, mixed);
  $(id + 'V').textContent = mixed ? 'Mixed' : fmt(+el.value);
  syncP(el);
}
function showSwitch(id: string, values: boolean[]): void {
  const el = input(id);
  const mixed = values.some((v) => v !== values[0]);
  el.checked = !mixed && !!values[0];
  setMixed(el, mixed);
}
const PER_PART = ['sym', 'clearance', 'slotOn', 'slotD', 'slotFrac', 'depth', 'rot'];
/** The inspector for the current tool and selection: what the per-part controls edit and their values, the
 * bin size, the hidden parts, and the selected (or only) part's pocket size and symmetry note. */
/** The per-part controls (Rotation aside, which always shows its part's angle), and how each shows its value. */
const OWN: Record<string, ((v: number) => string) | null> = {
  sym: null, slotOn: null,
  clearance: trim, slotD: String, slotFrac: (v) => String(Math.round(v * 100)), depth: trim,
};
/** The inspector's own per-part values, as last shown (kept while the controls show a laid-out tool's parts,
 * which an edit can start before the next sync), and whether they show such a tool's parts now. */
let ownControls: Map<string, string | boolean> | null = null;
let showingLayout = false;
function snapshotControls(): Map<string, string | boolean> {
  return new Map(Object.keys(OWN).map((id) => [id, OWN[id] ? input(id).value : input(id).checked]));
}
function restoreControls(saved: Map<string, string | boolean>): void {
  for (const [id, v] of saved) {
    const el = input(id);
    const fmt = OWN[id];
    if (fmt) {
      el.value = String(v);
      $(id + 'V').textContent = fmt(+el.value);
      syncP(el);
    } else el.checked = v as boolean;
  }
  syncDepth();
}
function syncInspector(): void {
  const l = currentLayout();
  const r = outlineNow();
  const vis = l?.placements.filter((pl) => !pl.hidden) ?? [];
  const sel = l && selectedIn(l);
  const multi = (l?.placements.length ?? 0) > 1;
  const inScope = l ? scope(l) : [];
  const num = (id: string) => (l?.placements.findIndex((pl) => pl.part === id) ?? -1) + 1;
  const trace = (id: string) => r?.parts.find((q) => q.id === id);
  $('scope').hidden = !multi;
  $('scopeText').textContent = sel ? `Part ${num(sel.part)}` : `All parts (${vis.length})`;
  $('scopeClear').hidden = !sel;
  // the parts' own values once the user has a layout; until then they all have the inspector's
  for (const id of PER_PART) setMixed(input(id), false);
  // the controls show a laid-out tool's parts; the inspector's own values (what a tool without a layout of its
  // own takes) are put aside meanwhile and back after, so a Mixed or unchecked state doesn't carry over
  const ownLayout = layouts.has(toolMenu.value) && inScope.length > 0;
  if (!ownLayout) {
    if (showingLayout && ownControls) restoreControls(ownControls);
    ownControls = snapshotControls();
  }
  showingLayout = ownLayout;
  if (ownLayout) {
    showSwitch('sym', inScope.map((pl) => pl.sym));
    showRange('clearance', inScope.map((pl) => pl.clearance), trim);
    showSwitch('slotOn', inScope.map((pl) => pl.slotOn));
    showRange('slotD', inScope.map((pl) => pl.slotR * 2), String);
    showRange('slotFrac', inScope.map((pl) => pl.slotFrac), (v) => String(Math.round(v * 100)));
    showRange('depth', inScope.map((pl) => pl.depth), trim);
  }
  // an edited outline replaces the traced one and its symmetric version
  const edited = inScope.some((pl) => !!pl.path);
  input('sym').disabled = edited;
  input('sym').title = edited ? 'This outline was edited in the Outline pane; reset it there to use the symmetric outline.' : '';
  // rotation turns one part: the selected one, or a kit's only one
  const turnable = !!sel || vis.length === 1;
  input('rot').disabled = !turnable;
  if (inScope.length) showRange('rot', inScope.map((pl) => Math.round(pl.rot)), (v) => `${v}°`);
  const one = turnable ? inScope[0] : undefined;
  const axis = one ? one.rot + (trace(one.part)?.axisDeg ?? 0) : NaN;
  const along = (deg: number) => Math.abs(normalizeDeg(axis - deg)) < 0.5 || Math.abs(normalizeDeg(axis - deg - 180)) < 0.5;
  for (const [id, deg] of [['rot0', 0], ['rot90', 90]] as const) {
    $<HTMLButtonElement>(id).disabled = !turnable;
    $(id).setAttribute('aria-pressed', String(along(deg)));
  }
  // bin size: auto, or locked to the layout's cells
  const half = input('halfGrid').checked;
  const cells = l?.cells ? lockedCells(l.cells, half) : r ? [r.nx, r.ny] : null;
  input('autoSize').checked = !l?.cells;
  input('autoSize').disabled = !l;
  (['cellsX', 'cellsY'] as const).forEach((id, i) => {
    const el = input(id);
    el.step = el.min = half ? '0.5' : '1';
    el.max = String(MAX_CELLS);
    el.disabled = !l?.cells;
    if (cells) el.value = String(cells[i]);
  });
  // hidden parts, each with Restore
  const hidden = l?.placements.filter((pl) => pl.hidden) ?? [];
  $('hiddenHead').hidden = $('hiddenParts').hidden = !hidden.length;
  $('hiddenParts').replaceChildren(...hidden.map((pl) => {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = `Part ${num(pl.part)}`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Restore';
    btn.dataset.part = pl.part;
    btn.setAttribute('aria-label', `Restore part ${num(pl.part)}`);
    row.append(name, btn);
    return row;
  }));
  // the pocket size of the selected (or only) part, and which parts in scope aren't symmetric enough
  const shown = r && (r.parts.length === 1 ? r.parts[0] : sel ? trace(sel.part) : undefined);
  const m = shown?.measure;
  $('pocketDims').textContent = m
    ? `Pocket ${m.pocketSize[0].toFixed(1)} × ${m.pocketSize[1].toFixed(1)} mm · tool ${m.toolSize[0].toFixed(1)} × ${m.toolSize[1].toFixed(1)} mm`
    : '';
  const asym = inScope.filter((pl) => pl.sym && (trace(pl.part)?.symmetryScore ?? 1) < SYMMETRIC_SCORE).map((pl) => num(pl.part));
  const symNote = $('symNote');
  symNote.hidden = !asym.length;
  symNote.textContent = !multi ? 'This tool doesn’t look symmetric — the pocket will be wider than needed.'
    : asym.length === 1 ? `Part ${asym[0]} doesn’t look symmetric — its pocket will be wider than needed.`
      : `Parts ${andList(asym)} don’t look symmetric — their pockets will be wider than needed.`;
  syncDepth();
}
const bind = (id: string, fmt: (v: number) => string) => {
  const el = input(id), out = $(id + 'V');
  out.textContent = fmt(+el.value);
  el.addEventListener('input', () => {
    out.textContent = fmt(+el.value);
    changed();
  });
};
/** A per-part slider: edits the parts in scope as it moves, one undo step per drag. */
function bindPart(id: string, fmt: (v: number) => string, write: (pl: Placement, v: number) => Placement): void {
  const el = input(id), out = $(id + 'V');
  out.textContent = fmt(+el.value);
  el.addEventListener('input', () => {
    setMixed(el, false);
    out.textContent = fmt(+el.value);
    editParts((pl) => write(pl, +el.value));
  });
  el.addEventListener('change', endGesture);
}
bindPart('clearance', trim, (pl, v) => ({ ...pl, clearance: v }));
bindPart('slotD', String, (pl, v) => ({ ...pl, slotR: v / 2 }));
bindPart('slotFrac', (v) => String(Math.round(v * 100)), (pl, v) => ({ ...pl, slotFrac: v }));
bind('u', (v) => v + 'U');
bind('fillet', trim);
bind('bfillet', trim);
input('u').addEventListener('input', syncDepth);
input('depth').addEventListener('input', () => {
  setMixed(input('depth'), false);
  syncDepth();
  editParts((pl) => ({ ...pl, depth: +input('depth').value }));
});
input('depth').addEventListener('change', endGesture);
for (const id of ['sym', 'slotOn'] as const) {
  input(id).addEventListener('change', () => {
    setMixed(input(id), false);
    editParts((pl) => ({ ...pl, [id]: input(id).checked }));
    endGesture();
    syncInspector();
  });
}
/** The part-frame point a part turns about: its pocket's centroid, as in the Layout pane. */
function pivot(id: string): Vec2 {
  const t = outlineNow()?.parts.find((q) => q.id === id);
  return t ? centroid(t.pocket) : [0, 0];
}
/** Turn the part in scope to `rot` degrees; this always gives the tool a layout of its own. */
const turnTo = (rot: number) => editParts((pl) => turnAbout(pl, pivot(pl.part), normalizeDeg(rot)), true);
input('rot').addEventListener('input', () => {
  setMixed(input('rot'), false);
  $('rotV').textContent = `${input('rot').value}°`;
  turnTo(+input('rot').value);
});
input('rot').addEventListener('change', endGesture);
// 0° and 90°: the part's axis along the bin or across it
for (const [id, deg] of [['rot0', 0], ['rot90', 90]] as const) {
  $(id).addEventListener('click', () => {
    const l = currentLayout();
    const pl = l && scope(l)[0];
    if (!pl) return;
    turnTo(deg - (outlineNow()?.parts.find((q) => q.id === pl.part)?.axisDeg ?? 0));
    endGesture();
    syncInspector();
  });
}
$('scopeClear').addEventListener('click', () => layoutView.select(null));
$('hiddenParts').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('button[data-part]')?.dataset.part;
  const l = currentLayout();
  if (!id || !l) return;
  layoutView.apply({ ...l, placements: l.placements.map((pl) => (pl.part === id ? { ...pl, hidden: false } : pl)) }, l);
});
// bin size: locking keeps the parts where they are (the locked bin is centred on the origin) at the size
// they need now; unlocking lets the bin grow to fit them again
input('autoSize').addEventListener('change', () => {
  const l = currentLayout();
  const r = outlineNow();
  if (!l || !r) return;
  if (input('autoSize').checked) {
    layoutView.apply({ placements: l.placements }, l);
    return;
  }
  const rings = l.placements.filter((pl) => !pl.hidden)
    .map((pl) => placeRing(r.parts.find((q) => q.id === pl.part)?.pocket ?? [], pl)).filter((P) => P.length);
  const b = bounds(rings.flat());
  const cx = (b.xmin + b.xmax) / 2;
  const cy = (b.ymin + b.ymax) / 2;
  layoutView.apply({
    placements: l.placements.map((pl) => ({ ...pl, x: pl.x - cx, y: pl.y - cy })),
    cells: lockedCells([r.nx, r.ny], input('halfGrid').checked),
  }, l);
});
(['cellsX', 'cellsY'] as const).forEach((id, i) => {
  input(id).addEventListener('change', () => {
    const l = currentLayout();
    if (!l?.cells) return;
    const cells: [number, number] = [...l.cells];
    cells[i] = +input(id).value;
    layoutView.apply({ ...l, cells: lockedCells(cells, input('halfGrid').checked) }, l);
  });
});
/** Holes and Corners only: unavailable with half-grid feet, and Corners only needs a hole style. */
function syncBase(): void {
  const half = input('halfGrid').checked;
  $<HTMLSelectElement>('holes').disabled = half;
  input('holesCorners').disabled = half || $<HTMLSelectElement>('holes').value === 'none';
  $('holesNote').hidden = half;
  $('halfGridNote').hidden = !half;
}
$('holes').addEventListener('change', () => {
  syncBase();
  syncDepth();
  changed();
});
syncBase();
input('holesCorners').addEventListener('change', changed);
input('halfGrid').addEventListener('change', () => {
  syncBase();
  syncDepth();
  changed();
});
input('lip').addEventListener('change', () => {
  syncDepth();
  changed();
});
/** Switch defaults and the Remove row for the selected tool. */
function applyToolDefaults(): void {
  const id = toolMenu.value;
  const t = tools.find((x) => x.id === id);
  if (t) input('sym').checked = t.sym;
  gestureStart = null;
  syncInspector();
  $('rmRow').hidden = !isUpload(id);
  if (isUpload(id)) void touchUpload(id).catch(() => {});
}
function selectTool(id: string): void {
  toolMenu.value = id;
  needFrame = true;
  applyToolDefaults();
  changed();
}
toolMenu.addEventListener('change', () => selectTool(toolMenu.value));
$('gen').addEventListener('click', () => void generate());

// ---- upload a new tool photo (calibration sheet required)
const upMsg = $('upMsg');
const upBtn = $<HTMLButtonElement>('upBtn');
function say(text: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
  upMsg.textContent = text;
  upMsg.classList.toggle('ok', tone === 'ok');
  upMsg.classList.toggle('error', tone === 'error');
}
/** The model download needs the user's go-ahead once; afterwards it is in the Cache API. */
let modelConsent = false;
function askModelConsent(): Promise<boolean> {
  const box = $('consent');
  box.hidden = false;
  $('consentYes').focus();
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      box.hidden = true;
      $('consentYes').removeEventListener('click', yes);
      $('consentNo').removeEventListener('click', no);
      resolve(ok);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $('consentYes').addEventListener('click', yes);
    $('consentNo').addEventListener('click', no);
  });
}
function showProgress(p: Progress): void {
  if (p.stage === 'sheet') say('Finding the sheet…');
  else if (p.stage === 'trace') say('Tracing…');
  else if (p.loaded < p.total) say(`Downloading the AI model… ${Math.floor((p.loaded / p.total) * 100)}%`);
  else say('Tracing…');
}
/** Where an upload is: set while the photo is decoded, so a failure there is counted as a decode error. */
const uploadStage = { decoding: false };
async function uploadPhoto(file: File): Promise<void> {
  if (!modelConsent && !(await modelCached().catch(() => false))) {
    say('');
    if (!(await askModelConsent())) {
      count('model-no');
      say('Upload cancelled. Nothing was downloaded.');
      return;
    }
    count('model-yes');
    modelConsent = true;
  }
  say('Reading the photo…');
  uploadStage.decoding = true;
  const image = await decodePhoto(file, file.name);
  uploadStage.decoding = false;
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
  const t = await client.request('upload', { image, name }, [image.data.buffer], showProgress);
  if (!t) return;
  let dropped: string[] = [];
  let saved = true;
  try {
    dropped = await saveUpload(t);
  } catch {
    saved = false; // e.g. storage full or private browsing: still usable until reload
  }
  count('upload-ok');
  dropped.forEach(dropUploadTool);
  addUploadTool(t);
  selectTool(t.id);
  const added = t.parts.length > 1 ? `Added “${t.label}” with ${t.parts.length} parts` : `Added “${t.label}”`;
  say(saved ? `${added}. Turn on “Symmetric tool” if it is.`
    : `${added} for this visit; this browser couldn't save it.`, 'ok');
}
upBtn.addEventListener('click', () => input('upFile').click());
input('upFile').addEventListener('change', async () => {
  const file = input('upFile').files?.[0];
  if (!file) return;
  upBtn.disabled = true;
  count('upload-start');
  uploadStage.decoding = false;
  try {
    await uploadPhoto(file);
  } catch (e) {
    count(uploadErrorEvent(e, uploadStage.decoding));
    say(errorText(e), 'error');
  } finally {
    upBtn.disabled = false;
    input('upFile').value = '';
  }
});
$('rmBtn').addEventListener('click', async () => {
  const id = toolMenu.value;
  if (!isUpload(id)) return;
  const label = tools.find((t) => t.id === id)?.label ?? '';
  try {
    await removeUpload(id);
  } catch (e) {
    say(errorText(e), 'error');
    return;
  }
  dropUploadTool(id);
  selectTool(tools[0]?.id ?? '');
  say(`Removed “${label}”.`);
});
window.addEventListener('resize', () => {
  trace.draw();
  layoutView.draw();
  outlineView.draw();
});

// ---- presentation listeners
// 1. slider fill (--p)
document.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((el) => {
  syncP(el);
  el.addEventListener('input', () => syncP(el));
});
// 2. inactive window
window.addEventListener('blur', () => document.documentElement.classList.add('inactive'));
window.addEventListener('focus', () => document.documentElement.classList.remove('inactive'));
// 3. inspector soft scroll edge
const ib = document.querySelector<HTMLElement>('.inspector-body')!;
ib.addEventListener('scroll', () => ib.classList.toggle('scrolled', ib.scrollTop > 0), { passive: true });
// 4. pointer illumination on interactive glass
document.querySelectorAll<HTMLElement>('.glass.interactive').forEach((g) =>
  g.addEventListener('pointermove', (e) => {
    const r = g.getBoundingClientRect();
    g.style.setProperty('--mx', e.clientX - r.left + 'px');
    g.style.setProperty('--my', e.clientY - r.top + 'px');
  }));
// 5. appearance changes
window.addEventListener('themechange', () => {
  applyTheme3D();
  trace.draw();
  layoutView.draw();
  outlineView.draw();
});

// ---- start
try {
  tools = (await client.request('listTools', {})) ?? [];
  tools.forEach((t) => addToolOption(t));
  try {
    (await loadUploads()).forEach(addUploadTool);
  } catch {
    say('Your saved uploads could not be loaded from this browser.', 'error');
  }
  applyToolDefaults();
  syncDepth();
  syncExport();
  pendingOutline = refreshOutline();
  await pendingOutline;
  void generate();
} catch (e) {
  previewMsg.textContent = errorText(e);
}
