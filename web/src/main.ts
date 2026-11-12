// Gridfinity Tool Studio UI: inspector controls, the 2D trace and the 3D preview.
// All processing runs in the pipeline worker (src/worker/).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { maxDepth } from './geometry/pocket';
import { clampParams, DEFAULTS, MAX_CELLS, type Params } from './params';
import { loadUploads, removeUpload, saveUpload, touchUpload } from './storage';
import { writeStl } from './stl';
import { traceDxf, traceSvg, type TraceLayers } from './trace-export';
import { isDark, TraceView } from './trace';
import { decodePhoto } from './vision/decode';
import { modelCached } from './vision/model';
import { PipelineClient } from './worker/client';
import { PipelineError, type BuildResult, type Progress, type ToolInfo, type UploadResult } from './worker/protocol';

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
function addUploadTool(u: UploadResult): void {
  const { sheetViewJpeg, ...rest } = u;
  const sheetImage = URL.createObjectURL(sheetViewJpeg);
  sheetUrls.set(u.id, sheetImage);
  void client.request('addTool', { tool: { ...rest, sheetImage } });
  tools.push({ id: u.id, label: u.label, sym: u.sym });
  addToolOption(u, uploadGroup);
  if (!uploadGroup.isConnected) toolMenu.appendChild(uploadGroup);
}
function dropUploadTool(id: string): void {
  void client.request('removeTool', { id });
  URL.revokeObjectURL(sheetUrls.get(id) ?? '');
  sheetUrls.delete(id);
  tools = tools.filter((t) => t.id !== id);
  [...uploadGroup.children].find((o) => (o as HTMLOptionElement).value === id)?.remove();
  if (!uploadGroup.children.length) uploadGroup.remove();
}

// ---- 2D trace
const trace = new TraceView($<HTMLCanvasElement>('flat'));

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

// ---- trace export: the current outline and pocket as SVG or DXF (1:1 mm)
let lastTrace: { tool: string; layers: TraceLayers } | null = null;
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
    r = await client.request('outline', { params: p });
  } catch (e) {
    previewMsg.textContent = errorText(e);
    return;
  }
  if (!r) return; // superseded by a newer change
  $('cells').textContent = `${r.nx}×${r.ny}`;
  $('pdim').textContent = `${r.w}×${r.h} mm`;
  $('bdim').textContent = `${(r.nx * 42 - 0.5).toFixed(0)}×${(r.ny * 42 - 0.5).toFixed(0)}×${(p.u * 7).toFixed(0)} mm`;
  $('symNote').hidden = !(p.sym && r.symmetryScore < SYMMETRIC_SCORE);
  tooLarge = r.nx > MAX_CELLS || r.ny > MAX_CELLS;
  if (tooLarge) {
    previewMsg.textContent = `This tool needs a ${r.nx}×${r.ny} bin; the largest is ${MAX_CELLS}×${MAX_CELLS}. ` +
      'Try a smaller rotation or clearance.';
  }
  trace.show(r);
  lastTrace = { tool: p.tool, layers: { tool: r.tool, pocket: r.pocket } };
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
      const r = await client.request('build', { params });
      if (r) {
        showMesh(r);
        shown = { version, tool: params.tool, bin: r };
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
/** Depth slider: capped to the deepest pocket the current height allows, showing the depth that will be cut. */
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
  $('depthV').textContent = trim(Math.min(+el.value, deepest));
  const note = $('depthNote');
  note.textContent = deepest > 0
    ? `Deepest pocket at ${u}U: ${trim(deepest)} mm.`
    : `A ${u}U bin is too short for a pocket. Use 2U or taller.`;
  note.classList.toggle('warn', deepest <= 0);
  syncP(el);
}
const bind = (id: string, fmt: (v: number) => string) => {
  const el = input(id), out = $(id + 'V');
  out.textContent = fmt(+el.value);
  el.addEventListener('input', () => {
    out.textContent = fmt(+el.value);
    changed();
  });
};
bind('clearance', trim);
bind('rot', (v) => v + '°');
bind('slotD', (v) => String(v));
bind('slotFrac', (v) => String(Math.round(v * 100)));
bind('u', (v) => v + 'U');
bind('fillet', trim);
bind('bfillet', trim);
input('u').addEventListener('input', syncDepth);
input('depth').addEventListener('input', () => {
  syncDepth();
  changed();
});
input('slotOn').addEventListener('change', changed);
$('holes').addEventListener('change', () => {
  input('holesCorners').disabled = $<HTMLSelectElement>('holes').value === 'none';
  syncDepth();
  changed();
});
input('holesCorners').disabled = true;
input('holesCorners').addEventListener('change', changed);
input('lip').addEventListener('change', () => {
  syncDepth();
  changed();
});
input('sym').addEventListener('change', changed);
/** Switch defaults and the Remove row for the selected tool. */
function applyToolDefaults(): void {
  const id = toolMenu.value;
  const t = tools.find((x) => x.id === id);
  if (t) input('sym').checked = t.sym;
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
async function uploadPhoto(file: File): Promise<void> {
  if (!modelConsent && !(await modelCached().catch(() => false))) {
    say('');
    if (!(await askModelConsent())) {
      say('Upload cancelled. Nothing was downloaded.');
      return;
    }
    modelConsent = true;
  }
  say('Reading the photo…');
  const image = await decodePhoto(file, file.name);
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
  dropped.forEach(dropUploadTool);
  addUploadTool(t);
  selectTool(t.id);
  say(saved ? `Added “${t.label}”. Turn on “Symmetric tool” if it is.`
    : `Added “${t.label}” for this visit; this browser couldn't save it.`, 'ok');
}
upBtn.addEventListener('click', () => input('upFile').click());
input('upFile').addEventListener('change', async () => {
  const file = input('upFile').files?.[0];
  if (!file) return;
  upBtn.disabled = true;
  try {
    await uploadPhoto(file);
  } catch (e) {
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
window.addEventListener('resize', () => trace.draw());

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
