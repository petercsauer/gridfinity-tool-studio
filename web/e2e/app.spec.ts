// End-to-end: presets, the 2D trace, the layout editor, the 3D build and STL export, the upload flow
// (model consent, tracing, persistence across reloads, removal, errors) and a two-part kit from photo to export. The 88 MB model and the onnxruntime wasm are served
// from local copies (web/.cache and node_modules) instead of Hugging Face and jsDelivr.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const MODEL = here('../.cache/model_fp16.onnx');
const ORT_DIST = here('../node_modules/onnxruntime-web/dist/');
const STRIPPER = here('../../assets/presets/stripper.jpg');
const KIT2 = here('../../assets/presets/kit2.jpg');

const cors = { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' };

// The model is too large to hand to route.fulfill (the DevTools pipe caps messages at 100 MB), so the
// Hugging Face request is redirected to this local server instead.
let modelServer: Server;
let modelUrl = '';
test.beforeAll(async () => {
  modelServer = createServer((_req, res) => {
    res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream', 'content-length': statSync(MODEL).size });
    createReadStream(MODEL).pipe(res);
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  modelUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/model_fp16.onnx`;
});
test.afterAll(() => new Promise<void>((resolve) => modelServer.close(() => resolve())));

/** Serve the model and the onnxruntime files locally. Returns how many model requests were made. */
async function offline(context: BrowserContext): Promise<{ model: number }> {
  const seen = { model: 0 };
  await context.route(/huggingface\.co\/.*model_fp16\.onnx/, (route) => {
    seen.model++;
    return route.fulfill({ status: 302, headers: { ...cors, location: modelUrl } });
  });
  await context.route(/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@[^/]+\/dist\/([^?]+)/, (route) => {
    const file = /\/dist\/([^?]+)/.exec(route.request().url())![1]!;
    const type = file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    return route.fulfill({ status: 200, path: ORT_DIST + file, headers: { ...cors, 'content-type': type } });
  });
  return seen;
}

/** A plain grey PNG (no calibration sheet). */
function plainPng(w = 64, h = 48): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    td.copy(out, 4);
    out.writeUInt32BE(crc(td), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x99);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0; // filter: none
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Load the app and wait until the first preset's trace and bin are shown. */
async function open(page: Page, url = './'): Promise<void> {
  await page.goto(url);
  await expect(page.locator('#tool > option')).toHaveCount(2);
  await expect(page.locator('#cells')).not.toBeEmpty();
  await expect(page.locator('.trace')).toHaveClass(/ready/);
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#exp')).toHaveText(/Export STL/);
}

/** Opaque pixels drawn on the trace canvas. */
const tracePixels = (page: Page) => page.locator('#flat').evaluate((c: HTMLCanvasElement) => {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
  return n;
});

const setSlider = (page: Page, id: string, value: number) => page.locator(`#${id}`).evaluate((el: HTMLInputElement, v) => {
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

const pageErrors = (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

test('presets load and the trace draws', async ({ page }) => {
  const errors = pageErrors(page);
  await open(page);
  await expect(page.locator('#tool > option')).toHaveText(['Groove-joint pliers', 'Stud finder']);
  await expect.poll(() => tracePixels(page)).toBeGreaterThan(10_000);
  // the trace and footprint follow the selected tool
  const before = await page.locator('#pdim').textContent();
  await page.locator('#tool').selectOption('studfinder');
  await expect(page.locator('#pdim')).not.toHaveText(before!);
  await expect(page.locator('#sym')).toBeChecked();
  await expect(page.locator('#symNote')).toBeHidden();
  // the groove-joint pliers aren't symmetric: turning the switch on warns
  await page.locator('#tool').selectOption('groovejoint');
  await expect(page.locator('#sym')).not.toBeChecked();
  await expect(page.locator('#symNote')).toBeHidden();
  await page.locator('#sym').check();
  await expect(page.locator('#symNote')).toBeVisible();
  await expect(page.locator('#rmRow')).toBeHidden();
  expect(errors).toEqual([]);
});

test('changing clearance updates the readout', async ({ page }) => {
  await open(page);
  const before = await page.locator('#pdim').textContent();
  await setSlider(page, 'clearance', 5);
  await expect(page.locator('#clearanceV')).toHaveText('5');
  await expect(page.locator('#pdim')).not.toHaveText(before!);
  const parse = (s: string | null) => s!.match(/[\d.]+/g)!.map(Number);
  const [w0, h0] = parse(before);
  const [w1, h1] = parse(await page.locator('#pdim').textContent());
  // 2.5 mm more clearance on each side: about 5 mm wider and taller
  expect(w1! - w0!).toBeCloseTo(5, 0);
  expect(h1! - h0!).toBeCloseTo(5, 0);
});

test('the bin builds and Export saves a valid binary STL', async ({ page }) => {
  await open(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#exp').click()]);
  expect(download.suggestedFilename()).toBe('gridfinity_groovejoint.stl');
  const stl = readFileSync((await download.path())!);
  const triangles = stl.readUInt32LE(80);
  expect(triangles).toBeGreaterThan(1000);
  expect(stl.length).toBe(84 + 50 * triangles);
  // every vertex is finite and inside a 1x1..8x8 bin
  for (let t = 0; t < triangles; t += 97) {
    for (let k = 0; k < 12; k++) {
      const v = stl.readFloatLE(84 + t * 50 + k * 4);
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThan(8 * 42);
    }
  }
});

test('an uploaded photo is traced, survives a reload and can be removed', async ({ page, context }) => {
  test.skip(!existsSync(MODEL), 'Model not cached: run the unit tests once (npm test) to download web/.cache/model_fp16.onnx');
  const seen = await offline(context);
  const errors = pageErrors(page);
  await open(page);

  // first upload: asks before downloading the model; Cancel downloads nothing
  await page.locator('#upFile').setInputFiles(STRIPPER);
  await expect(page.locator('#consent')).toBeVisible();
  await expect(page.locator('#consentText')).toContainText('88 MB');
  await page.locator('#consentNo').click();
  await expect(page.locator('#consent')).toBeHidden();
  await expect(page.locator('#upMsg')).toHaveText(/cancelled/);
  await expect(page.locator('#upBtn')).toBeEnabled();
  expect(seen.model).toBe(0);

  await page.locator('#upFile').setInputFiles(STRIPPER);
  await page.locator('#consentYes').click();
  await expect(page.locator('#upBtn')).toBeDisabled();
  await expect(page.locator('#upMsg')).toHaveText(/Added “stripper”/, { timeout: 200_000 });
  await expect(page.locator('#upMsg')).toHaveClass(/ok/);
  await expect(page.locator('#upBtn')).toBeEnabled();
  expect(seen.model).toBe(1);
  const uploaded = page.locator('#tool optgroup[label="Your uploads"] option');
  await expect(uploaded).toHaveText(['stripper']);
  const id = await uploaded.getAttribute('value');
  await expect(page.locator('#tool')).toHaveValue(id!);
  await expect(page.locator('#rmRow')).toBeVisible();
  await expect(page.locator('#sym')).not.toBeChecked();
  // the stripper on its own sheet, and its bin
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#exp')).toHaveText(/Export STL/);
  await expect(page.locator('#previewMsg')).toBeEmpty();
  await expect.poll(() => tracePixels(page)).toBeGreaterThan(10_000);
  await page.screenshot({ path: test.info().outputPath('after-upload.png') });

  // persisted: still in the menu after a reload, and the model isn't downloaded again
  await page.reload();
  await open(page);
  await expect(uploaded).toHaveText(['stripper']);
  await page.locator('#tool').selectOption(id!);
  await expect(page.locator('#rmRow')).toBeVisible();
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#exp')).toHaveText(/Export STL/);
  await expect(page.locator('#previewMsg')).toBeEmpty();

  // removal: gone from the menu, the selection falls back to a preset, and it stays gone
  await page.locator('#rmBtn').click();
  await expect(uploaded).toHaveCount(0);
  await expect(page.locator('#tool')).toHaveValue('groovejoint');
  await expect(page.locator('#rmRow')).toBeHidden();
  await expect(page.locator('#upMsg')).toHaveText(/Removed “stripper”/);
  await page.reload();
  await open(page);
  await expect(page.locator('#tool > option')).toHaveCount(2);
  expect(seen.model).toBe(1);
  expect(errors).toEqual([]);
});

test('a photo without the calibration sheet shows the no-sheet error', async ({ page, context }) => {
  await offline(context);
  await open(page);
  await page.locator('#upFile').setInputFiles({ name: 'plain.png', mimeType: 'image/png', buffer: plainPng() });
  await page.locator('#consentYes').click();
  await expect(page.locator('#upMsg')).toHaveClass(/error/, { timeout: 60_000 });
  await expect(page.locator('#upMsg')).toContainText(/marker|sheet/i);
  await expect(page.locator('#upBtn')).toBeEnabled();
  await expect(page.locator('#tool > option')).toHaveCount(2);
});

test('the privacy page renders and is linked from the inspector', async ({ page }) => {
  await open(page);
  await page.locator('.footer.legal a[href="privacy.html"]').click();
  await expect(page).toHaveURL(/privacy\.html$/);
  await expect(page.locator('h1')).toHaveText('Privacy');
  await expect(page.locator('body')).toContainText('never uploaded');
  await expect(page.locator('body')).toContainText('Hugging Face');
  await expect(page.locator('body')).toContainText('jsDelivr');
  await expect(page.locator('body')).toContainText('Cloudflare Pages');
  await page.screenshot({ path: test.info().outputPath('privacy.png'), fullPage: true });
});

test('the trace downloads as SVG and DXF in millimetres', async ({ page }) => {
  await open(page);
  await expect(page.locator('#expSvg')).toBeEnabled();
  const [svgDl] = await Promise.all([page.waitForEvent('download'), page.locator('#expSvg').click()]);
  expect(svgDl.suggestedFilename()).toBe('trace_groovejoint.svg');
  const svg = readFileSync((await svgDl.path())!, 'utf8');
  expect(svg).toMatch(/<svg [^>]*width="[\d.]+mm" height="[\d.]+mm"/);
  expect(svg.match(/<path d="M/g)).toHaveLength(2);
  const [dxfDl] = await Promise.all([page.waitForEvent('download'), page.locator('#expDxf').click()]);
  expect(dxfDl.suggestedFilename()).toBe('trace_groovejoint.dxf');
  const dxf = readFileSync((await dxfDl.path())!, 'utf8');
  expect(dxf).toContain('AC1009');
  expect(dxf.match(/\r\nPOLYLINE\r\n/g)).toHaveLength(2);
  expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
});

test('base holes and the lip toggle rebuild the bin and change the deepest pocket', async ({ page }) => {
  await open(page);
  const deepest = async () => +((await page.locator('#depthNote').textContent())!.match(/([\d.]+) mm/)![1]!);
  const d0 = await deepest();
  await expect(page.locator('#holesCorners')).toBeDisabled();
  await page.locator('#holes').selectOption('screw');
  await expect(page.locator('#holesCorners')).toBeEnabled();
  expect(await deepest()).toBeCloseTo(d0 - 1.25, 2); // floor above the 6 mm screw holes
  await page.locator('#lip').uncheck();
  expect(await deepest()).toBeCloseTo(d0 - 1.25 + 4.4, 2);
  await expect(page.locator('#exp')).toHaveText(/Export STL/, { timeout: 60_000 });
  await expect(page.locator('#exp')).toBeEnabled();
  await expect(page.locator('#previewMsg')).toHaveText('');
});

test('the mirror axis shows on the trace only while Symmetric tool is on', async ({ page }) => {
  await open(page);
  await expect(page.locator('#sym')).not.toBeChecked();
  await expect(page.locator('.trace')).not.toHaveClass(/has-axis/);
  await page.locator('#tool').selectOption('studfinder');
  await expect(page.locator('#sym')).toBeChecked();
  await expect(page.locator('.trace')).toHaveClass(/has-axis/);
  await expect(page.locator('.lg-axis')).toBeVisible();
  await page.locator('#sym').uncheck();
  await expect(page.locator('.trace')).not.toHaveClass(/has-axis/);
  await expect(page.locator('.lg-axis')).toBeHidden();
});

test('half-grid feet give half-cell footprints and turn the holes off', async ({ page }) => {
  const errors = pageErrors(page);
  await open(page);
  await page.locator('#tool').selectOption('studfinder');
  await expect(page.locator('#cells')).toHaveText('4×5');
  await page.locator('#holes').selectOption('screw');
  const deepest = async () => +((await page.locator('#depthNote').textContent())!.match(/([\d.]+) mm/)![1]!);
  const withScrews = await deepest();
  await expect(page.locator('#halfGridNote')).toBeHidden();
  await page.locator('#halfGrid').check();
  await expect(page.locator('#cells')).toHaveText('3.5×5');
  await expect(page.locator('#bdim')).toHaveText(/^147×210×/); // 3.5 × 42 − 0.5 = 146.5
  await expect(page.locator('#holes')).toBeDisabled();
  await expect(page.locator('#holesCorners')).toBeDisabled();
  await expect(page.locator('#halfGridNote')).toBeVisible();
  await expect(page.locator('#holesNote')).toBeHidden();
  expect(await deepest()).toBeCloseTo(withScrews + 1.25, 2); // no screw holes, so the usual floor
  await expect(page.locator('#exp')).toHaveText(/Export STL/, { timeout: 60_000 });
  await expect(page.locator('#exp')).toBeEnabled();
  await expect(page.locator('#previewMsg')).toHaveText('');
  await page.locator('#halfGrid').uncheck();
  await expect(page.locator('#cells')).toHaveText('4×5');
  await expect(page.locator('#holes')).toBeEnabled();
  await expect(page.locator('#holesCorners')).toBeEnabled();
  expect(await deepest()).toBeCloseTo(withScrews, 2);
  expect(errors).toEqual([]);
});

test('the pocket and tool sizes show on the trace and under the pocket settings', async ({ page }) => {
  await open(page);
  await expect(page.locator('.trace')).toHaveClass(/has-measure/);
  const dims = page.locator('#pocketDims');
  await expect(dims).toHaveText(/^Pocket [\d.]+ × [\d.]+ mm · tool [\d.]+ × [\d.]+ mm$/);
  const nums = async () => (await dims.textContent())!.match(/[\d.]+/g)!.map(Number);
  const [pw, ph, tw, th] = await nums();
  expect(pw!).toBeGreaterThan(tw!);
  expect(ph!).toBeGreaterThan(th!);
  // the sizes are along the tool's own axes, so rotating the pocket in the bin doesn't change them
  await setSlider(page, 'rot', 30);
  await expect(page.locator('#rotV')).toHaveText('30°');
  await expect(page.locator('#pdim')).not.toHaveText(`${pw}×${ph} mm`);
  expect(await nums()).toEqual([pw, ph, tw, th]);
  await setSlider(page, 'clearance', 4);
  await expect.poll(async () => (await nums())[0]).toBeCloseTo(pw! + 3, 0);
});

/** Record the layout sent with every outline and build request (null when the kit's initial layout is used). */
async function recordOutlines(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { outlines: unknown[]; builds: unknown[] };
    w.outlines = [];
    w.builds = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, msg: { kind?: string; layout?: unknown }, ...rest: never[]) {
      if (msg?.kind === 'outline') w.outlines.push(msg.layout ?? null);
      if (msg?.kind === 'build') w.builds.push(msg.layout ?? null);
      return (post as (...a: unknown[]) => void).call(this, msg, ...rest);
    };
  });
}
type SentPlacement = { x: number; y: number; rot: number; depth: number; clearance: number; hidden?: boolean };
type SentLayout = { placements: SentPlacement[]; cells?: [number, number] } | null;
const lastLayout = (page: Page) => page.evaluate(() => (window as unknown as { outlines: SentLayout[] }).outlines.at(-1) ?? null);
const lastBuild = (page: Page) => page.evaluate(() => (window as unknown as { builds: SentLayout[] }).builds.at(-1) ?? null);
const sentPlacement = async (page: Page) => (await lastLayout(page))?.placements[0];

/** Click around the middle of the layout until a part is hit; returns that point (page px). */
async function grabPart(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator('#plan').boundingBox())!;
  const selected = page.locator('#partList [aria-selected=true]');
  for (let r = 0; r < 240; r += 10) {
    for (let a = 0; a < 360; a += r ? 20 : 360) {
      const x = box.x + box.width / 2 + r * Math.cos((a * Math.PI) / 180);
      const y = box.y + box.height / 2 + r * Math.sin((a * Math.PI) / 180);
      await page.mouse.click(x, y);
      if (await selected.count()) return { x, y };
    }
  }
  throw new Error('no part under the layout centre');
}

/** Hold the selected part's rotation handle a little off its axis (still snapped), screenshot, and let go. */
async function shootSnapped(page: Page, name: string): Promise<void> {
  const box = (await page.locator('#plan').boundingBox())!;
  const [hx, hy] = (await page.locator('#plan').getAttribute('data-handle'))!.split(' ').map(Number);
  const s = Number(await page.locator('#plan').getAttribute('data-scale'));
  await page.mouse.move(box.x + hx!, box.y + hy!);
  await page.mouse.down();
  await page.mouse.move(box.x + hx! + 0.3 * s, box.y + hy!, { steps: 3 }); // about 1.5° at 12 mm or more
  await page.screenshot({ path: test.info().outputPath(name) });
  await page.mouse.up();
}

test('layout: drag and snap', async ({ page }) => {
  const errors = pageErrors(page);
  await recordOutlines(page);
  await open(page);
  // a single tool opens in Trace; its layout is the initial one until it is edited
  await expect(page.locator('#tracePane')).toBeVisible();
  await expect(page.locator('#layoutPane')).toBeHidden();
  expect(await lastLayout(page)).toBeNull();
  await page.locator('#tabLayout').click();
  await expect(page.locator('#tabLayout')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#partList [role=option]')).toHaveText(['Part 1']);

  const s = Number(await page.locator('#plan').getAttribute('data-scale'));
  expect(s).toBeGreaterThan(0);
  const at = await grabPart(page);
  await expect(page.locator('#layoutStatus')).toHaveText(/^Part 1 at 0, 0 mm, 0°$/);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 20 * s, at.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await sentPlacement(page))?.x).toBeGreaterThan(19);
  const pl = (await sentPlacement(page))!;
  expect(pl.x).toBeLessThan(21);
  expect(Math.abs(pl.y)).toBeLessThan(1);
  expect(pl.rot).toBe(0);

  // ] turns it 90° (the bin turns with it), and undo turns it back
  const cells = await page.locator('#cells').textContent();
  const [cx, cy] = cells!.split('×');
  await expect(page.locator('#plan')).toBeFocused();
  await page.keyboard.press(']');
  await expect.poll(async () => (await sentPlacement(page))?.rot).toBe(90);
  await expect(page.locator('#cells')).toHaveText(`${cy}×${cx}`);
  await expect(page.locator('#rotV')).toHaveText('90°');
  await expect(page.locator('#layoutStatus')).toContainText('90°');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await sentPlacement(page))?.rot).toBe(0);
  await expect(page.locator('#cells')).toHaveText(cells!);
  expect((await sentPlacement(page))!.x).toBeCloseTo(pl.x, 6);
  await expect(page.locator('#exp')).toHaveText(/Export STL/, { timeout: 60_000 });
  await expect(page.locator('#exp')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('layout: light and dark', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await open(page, `./?theme=${theme}`);
    await page.locator('#tool').selectOption('studfinder');
    await expect(page.locator('#cells')).toHaveText('4×5');
    await page.locator('#tabLayout').click();
    await page.locator('#partList [role=option]').first().click();
    await expect(page.locator('#plan')).not.toHaveAttribute('data-handle', '');
    await shootSnapped(page, `layout-${theme}.png`);
  }
});

test('layout: keys and the part list move a part without dragging', async ({ page }) => {
  await recordOutlines(page);
  await open(page);
  await page.locator('#tabLayout').click();
  await page.locator('#partList [role=option]').first().click();
  await expect(page.locator('#partList [role=option]').first()).toBeFocused();
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await sentPlacement(page))?.y).toBe(10);
  expect((await sentPlacement(page))!.x).toBe(-1);
  await expect(page.locator('#layoutStatus')).toHaveText('Part 1 at -1, 10 mm, 0°');
  // the last part can't be removed; Escape clears the selection
  await page.keyboard.press('Delete');
  await expect(page.locator('#layoutStatus')).toHaveText(/at least one part/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#partList [aria-selected=true]')).toHaveCount(0);
  // the slider turns a laid-out single tool
  await setSlider(page, 'rot', 45);
  await expect.poll(async () => (await sentPlacement(page))?.rot).toBe(45);
});

test('layout persists: a moved upload keeps its placement after a reload', async ({ page, context }) => {
  test.skip(!existsSync(MODEL), 'Model not cached: run the unit tests once (npm test) to download web/.cache/model_fp16.onnx');
  await offline(context);
  await recordOutlines(page);
  await open(page);
  await page.locator('#upFile').setInputFiles(STRIPPER);
  await page.locator('#consentYes').click();
  await expect(page.locator('#upMsg')).toHaveText(/Added “stripper”/, { timeout: 200_000 });
  const id = await page.locator('#tool').inputValue();
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 60_000 }); // its outline is in, so the pane is chosen
  await page.locator('#tabLayout').click();
  await page.locator('#partList [role=option]').first().click();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press(']');
  await expect.poll(async () => (await sentPlacement(page))?.rot).toBe(90);
  const moved = (await sentPlacement(page))!;
  const stored = () => page.evaluate(() => new Promise<{ x: number; rot: number } | null>((resolve) => {
    const rq = indexedDB.open('gridfinity-tool-studio-kits');
    rq.onsuccess = () => {
      const all = rq.result.transaction('uploads').objectStore('uploads').getAll();
      all.onsuccess = () => {
        resolve(all.result[0]?.layout?.placements[0] ?? null);
        rq.result.close();
      };
    };
  }));
  await expect.poll(async () => (await stored())?.rot).toBe(90);

  await page.reload();
  await open(page);
  await page.locator('#tool').selectOption(id);
  await expect.poll(async () => (await sentPlacement(page))?.rot).toBe(90);
  const back = (await sentPlacement(page))!;
  expect(back.x).toBeCloseTo(moved.x, 6);
  expect(back.y).toBeCloseTo(moved.y, 6);
  await expect(page.locator('#rotV')).toHaveText('90°');
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 60_000 });
});

// ---- kits with several parts: a two-part kit stored the way storage.ts keeps an upload (schema 2, in the kits'
// database), made from the stud finder and flush cutter presets at 0.3 scale (so they fit a 3×2 bin),
// photographed 60 mm apart
const KIT = 'kit-e2e';
type PresetJson = {
  outline_mm: number[][]; symmetric_outline_mm: number[][]; crop_mm: number[]; symmetry_score: number;
  symmetry_axis: { deg: number; offset: number; centre: number[] };
};
function kitParts(scale = 0.3) {
  const presets: PresetJson[] = [here('../public/presets/studfinder.json'), here('../../tests/fixtures/web-presets/flushcutter.json')]
    .map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const sc = (P: number[][]) => P.map(([x, y]) => [x! * scale, y! * scale]);
  return presets.map((p, i) => ({
    id: `p${i + 1}`,
    outline: sc(p.outline_mm),
    crop: p.crop_mm.map((v) => v * scale),
    up2sheet: [[1, 0, 80 + 60 * i], [0, 1, 140]],
    symmetry: {
      outline: sc(p.symmetric_outline_mm), score: p.symmetry_score, axisDeg: p.symmetry_axis.deg,
      offset: p.symmetry_axis.offset * scale, centre: sc([p.symmetry_axis.centre])[0],
    },
  }));
}

/** Store the two-part kit in IndexedDB, reload, and select it. */
async function openKit(page: Page): Promise<void> {
  await open(page); // the app has made its store
  await page.evaluate(async ({ id, parts }) => {
    const sheetViewJpeg = await (await fetch('presets/studfinder-sheet.jpg')).blob();
    const now = Date.now();
    const record = {
      id, label: 'Two-part kit', sym: false, parts, sheetViewJpeg, sheetBox: [10.68, 14.68, 205.22, 264.72],
      schema: 2, created: now, used: now,
    };
    await new Promise<void>((resolve, reject) => {
      const rq = indexedDB.open('gridfinity-tool-studio-kits');
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        const tx = rq.result.transaction('uploads', 'readwrite');
        tx.objectStore('uploads').put(record, id);
        tx.oncomplete = () => {
          rq.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, { id: KIT, parts: kitParts() });
  await page.reload();
  await open(page);
  await page.locator('#tool').selectOption(KIT);
  await expect(page.locator('#layoutPane')).toBeVisible();
  await expect(page.locator('#partList [role=option]')).toHaveText(['Part 1', 'Part 2']);
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 60_000 });
}

/** Each visible part's pivot on the layout canvas (page px), in layout order. */
async function partsOnScreen(page: Page): Promise<{ x: number; y: number }[]> {
  const box = (await page.locator('#plan').boundingBox())!;
  const parts = (await page.locator('#plan').getAttribute('data-parts'))!;
  return parts.split(', ').map((s) => {
    const [, x, y] = s.split(' ');
    return { x: box.x + Number(x), y: box.y + Number(y) };
  });
}

/** Scroll the inspector to the pocket settings, for a screenshot. */
const showPocketSettings = (page: Page) => page.locator('.section-row').evaluate((el) => el.scrollIntoView({ block: 'start' }));

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, hold?: () => Promise<void>) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await hold?.();
  await page.mouse.up();
}

test('kit part settings: a depth for one part, a clearance for all, and the mixed state', async ({ page }) => {
  const errors = pageErrors(page);
  await recordOutlines(page);
  await openKit(page);
  const depths = async () => (await lastBuild(page))?.placements.map((pl) => pl.depth);
  await expect(page.locator('#scopeText')).toHaveText('All parts (2)');
  await expect(page.locator('#scopeClear')).toBeHidden();
  await expect(page.locator('#rot')).toBeDisabled(); // parts turn one at a time
  await expect(page.locator('#pocketDims')).toBeEmpty();

  // part 2 alone
  await page.locator('#partList [role=option]').nth(1).click();
  await expect(page.locator('#scopeText')).toHaveText('Part 2');
  await expect(page.locator('#rot')).toBeEnabled();
  await expect(page.locator('#pocketDims')).toHaveText(/^Pocket [\d.]+ × [\d.]+ mm · tool [\d.]+ × [\d.]+ mm$/);
  await setSlider(page, 'depth', 8);
  await expect(page.locator('#depthV')).toHaveText('8');
  await expect.poll(depths).toEqual([10, 8]);
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator('#depthNote')).toHaveText(/Cut depths: part 1 10 mm, part 2 8 mm\.$/);
  await expect(page.locator('#depth').locator('..')).not.toHaveClass(/mixed/);
  await showPocketSettings(page);
  await page.screenshot({ path: test.info().outputPath('inspector-part.png') });

  // nothing selected: both parts, whose depths differ
  await page.locator('#scopeClear').click();
  await expect(page.locator('#scopeText')).toHaveText('All parts (2)');
  await expect(page.locator('#depthV')).toHaveText('Mixed');
  await expect(page.locator('#depth').locator('..')).toHaveClass(/mixed/);
  await expect(page.locator('#depth')).toHaveAttribute('aria-valuetext', 'Mixed');
  await expect(page.locator('#clearanceV')).toHaveText('2.5');
  await setSlider(page, 'clearance', 1);
  await expect.poll(async () => (await lastBuild(page))?.placements.map((pl) => pl.clearance)).toEqual([1, 1]);
  expect(await depths()).toEqual([10, 8]);
  await expect(page.locator('#depthV')).toHaveText('Mixed');
  expect(errors).toEqual([]);
});

test('kit bin size: locked at 3×2, a part dragged out sticks out', async ({ page }) => {
  await recordOutlines(page);
  await openKit(page);
  // without finger slots (for both parts) the small parts fit a 3×2 bin
  await page.locator('#slotOn').uncheck();
  await expect(page.locator('#cells')).toHaveText('3×2');
  await expect(page.locator('#autoSize')).toBeChecked();
  await expect(page.locator('#cellsX')).toBeDisabled();
  const auto = (await page.locator('#cells').textContent())!.split('×').map(Number);
  await page.locator('#autoSize').uncheck();
  await expect.poll(async () => (await lastLayout(page))?.cells).toEqual(auto);
  await expect(page.locator('#cellsX')).toBeEnabled();
  for (const [id, n] of [['cellsX', '3'], ['cellsY', '2']]) {
    await page.locator(`#${id}`).fill(n!);
    await page.locator(`#${id}`).dispatchEvent('change');
  }
  await expect(page.locator('#cells')).toHaveText('3×2');
  await expect.poll(async () => (await lastLayout(page))?.cells).toEqual([3, 2]);
  await expect(page.locator('#layoutWarnings li')).toHaveCount(0);

  // part 1 dragged 60 mm left, past the bin's side
  const s = Number(await page.locator('#plan').getAttribute('data-scale'));
  const [p1] = await partsOnScreen(page);
  await drag(page, p1!, { x: p1!.x - 60 * s, y: p1!.y });
  await expect(page.locator('#layoutWarnings li')).toHaveText(['Part 1 sticks out of the locked 3×2 bin.']);
  await expect(page.locator('#layoutWarnings')).toBeVisible();
  await expect(page.locator('#partList li.warned')).toHaveText(['Part 1']);
  await expect(page.locator('#partList li.warned')).toBeVisible();
  await expect(page.locator('#cells')).toHaveText('3×2');

  // auto again: the bin grows to fit
  await page.locator('#autoSize').check();
  await expect(page.locator('#layoutWarnings li')).toHaveCount(0);
  await expect(page.locator('#cells')).not.toHaveText('3×2');
  await expect(page.locator('#cellsX')).toBeDisabled();
});

test('kit warnings: parts dragged together will merge, and a hidden part comes back', async ({ page }) => {
  const errors = pageErrors(page);
  await recordOutlines(page);
  await openKit(page);
  // different depths, so with nothing selected the inspector shows Mixed
  await page.locator('#partList [role=option]').nth(1).click();
  await setSlider(page, 'depth', 8);
  await expect.poll(async () => (await lastBuild(page))?.placements.map((pl) => pl.depth)).toEqual([10, 8]);

  // part 2 onto part 1: ringed as too close while held, then the worker's warning
  const [p1, p2] = await partsOnScreen(page);
  await drag(page, p2!, { x: p1!.x + 6, y: p1!.y }, async () => {
    await expect(page.locator('#plan')).toHaveAttribute('data-close', /p1/);
  });
  await expect(page.locator('#layoutWarnings li')).toHaveText(['Parts 1 and 2 overlap; their pockets will merge.']);
  await expect(page.locator('#partList li.warned')).toHaveCount(2);
  await expect(page.locator('#plan')).toHaveAttribute('data-close', '');
  await expect(page.locator('#exp')).toHaveText(/Export STL/, { timeout: 60_000 });
  await expect(page.locator('#exp')).toBeEnabled();
  await expect(page.locator('#previewMsg')).toBeEmpty();
  await page.keyboard.press('Escape');
  await expect(page.locator('#scopeText')).toHaveText('All parts (2)');
  await expect(page.locator('#depthV')).toHaveText('Mixed');
  await showPocketSettings(page);
  await page.screenshot({ path: test.info().outputPath('inspector-mixed.png') });

  // hide part 1, then restore it from Hidden parts
  await page.locator('#partList [role=option]').first().click();
  await page.keyboard.press('Delete');
  await expect(page.locator('#partList [role=option]')).toHaveText(['Part 2']);
  await expect(page.locator('#hiddenParts')).toBeVisible();
  await expect(page.locator('#layoutWarnings li')).toHaveCount(0);
  await expect.poll(async () => (await lastBuild(page))?.placements.map((pl) => !!pl.hidden)).toEqual([true, false]);
  await page.getByRole('button', { name: 'Restore part 1' }).click();
  await expect(page.locator('#partList [role=option]')).toHaveText(['Part 1', 'Part 2']);
  await expect(page.locator('#hiddenParts')).toBeHidden();
  await expect.poll(async () => (await lastBuild(page))?.placements.map((pl) => !!pl.hidden)).toEqual([false, false]);
  expect(errors).toEqual([]);
});

/** A downloaded binary STL's triangle count, after checking its size and that every sampled vertex is finite
 * and inside an 8×8 bin. */
function checkStl(stl: Buffer): number {
  const triangles = stl.readUInt32LE(80);
  expect(stl.length).toBe(84 + 50 * triangles);
  for (let t = 0; t < triangles; t += 97) {
    for (let k = 0; k < 12; k++) {
      const v = stl.readFloatLE(84 + t * 50 + k * 4);
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThan(8 * 42);
    }
  }
  return triangles;
}

test('kit flow: a two-part photo is arranged, exported as STL and SVG, and kept', async ({ page, context }) => {
  test.skip(!existsSync(MODEL), 'Model not cached: run the unit tests once (npm test) to download web/.cache/model_fp16.onnx');
  const errors = pageErrors(page);
  await offline(context);
  await recordOutlines(page);
  await open(page);

  // the composite photo (scripts/make_kit_photo.py): the flush cutter and the needle-nose pliers
  await page.locator('#upFile').setInputFiles(KIT2);
  await page.locator('#consentYes').click();
  await expect(page.locator('#upMsg')).toHaveText(/Added “kit2” with 2 parts/, { timeout: 200_000 });
  const id = await page.locator('#tool').inputValue();
  await expect(page.locator('#layoutPane')).toBeVisible();
  await expect(page.locator('#partList [role=option]')).toHaveText(['Part 1', 'Part 2']);
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 60_000 });

  // part 2 dragged 30 mm left (part 1 stays), then turned 90° with ]
  const s = Number(await page.locator('#plan').getAttribute('data-scale'));
  const [a1, a2] = await partsOnScreen(page);
  // a point on part 2's pocket: its pivot (the pocket's centroid) can fall between a pliers' handles
  let at = a2!;
  for (let r = 0, found = false; !found; r += 4) {
    expect(r).toBeLessThan(200);
    for (let k = 0; k < 360 && !found; k += r ? 30 : 360) {
      at = { x: a2!.x + r * Math.cos((k * Math.PI) / 180), y: a2!.y + r * Math.sin((k * Math.PI) / 180) };
      await page.mouse.click(at.x, at.y);
      found = (await page.locator('#scopeText').textContent()) === 'Part 2';
    }
  }
  await drag(page, at, { x: at.x - 30 * s, y: at.y });
  await expect.poll(async () => (await lastLayout(page))?.placements.length).toBe(2);
  const [b1, b2] = await partsOnScreen(page);
  const s2 = Number(await page.locator('#plan').getAttribute('data-scale')); // the view refits after a drag
  expect((b2!.x - b1!.x) / s2 - (a2!.x - a1!.x) / s).toBeCloseTo(-30, 0);
  expect((b2!.y - b1!.y) / s2 - (a2!.y - a1!.y) / s).toBeCloseTo(0, 0);
  const dragged = (await lastLayout(page))!.placements;
  await expect(page.locator('#plan')).toBeFocused();
  await page.keyboard.press(']');
  const turned = dragged[1]!.rot + 90 > 180 ? dragged[1]!.rot - 270 : dragged[1]!.rot + 90; // in (-180, 180], as kit.ts keeps angles
  await expect.poll(async () => (await lastLayout(page))?.placements[1]!.rot).toBeCloseTo(turned, 6);
  const arranged = (await lastLayout(page))!.placements;
  expect(arranged[0]).toEqual(dragged[0]);
  await expect(page.locator('#exp')).toHaveText(/Export STL/, { timeout: 60_000 });
  await expect(page.locator('#exp')).toBeEnabled();
  await expect(page.locator('#previewMsg')).toBeEmpty();
  await page.screenshot({ path: test.info().outputPath('kit-layout.png') });

  // the bin as a valid binary STL
  const [stlDl] = await Promise.all([page.waitForEvent('download'), page.locator('#exp').click()]);
  expect(stlDl.suggestedFilename()).toBe(`gridfinity_${id}.stl`);
  expect(checkStl(readFileSync((await stlDl.path())!))).toBeGreaterThan(1000);

  // the arrangement as SVG and DXF: a path per part in the tool and pocket layers, and the bin's outline
  const [svgDl] = await Promise.all([page.waitForEvent('download'), page.locator('#expSvg').click()]);
  expect(svgDl.suggestedFilename()).toBe(`trace_${id}.svg`);
  const svg = readFileSync((await svgDl.path())!, 'utf8');
  expect(svg.match(/<path id="tool-p\d+"/g)).toEqual(['<path id="tool-p1"', '<path id="tool-p2"']);
  expect(svg.match(/<path id="pocket-p\d+"/g)).toEqual(['<path id="pocket-p1"', '<path id="pocket-p2"']);
  expect(svg).toMatch(/<g id="bin" inkscape:groupmode="layer"[^>]*>\s*<path d="M[^"]+"\/>/);
  const [dxfDl] = await Promise.all([page.waitForEvent('download'), page.locator('#expDxf').click()]);
  const dxf = readFileSync((await dxfDl.path())!, 'utf8');
  expect([...dxf.matchAll(/\r\nPOLYLINE\r\n {2}8\r\n(\w+)\r\n/g)].map((m) => m[1])).toEqual(['TOOL', 'TOOL', 'POCKET', 'POCKET', 'BIN']);

  // the Trace pane: both parts as photographed, part 2 highlighted with its dimensions; clicking part 1
  // selects it there, in the part list and in the inspector
  await page.locator('#tabTrace').click();
  await expect(page.locator('#flat')).toHaveAttribute('data-selected', 'p2');
  await expect(page.locator('.trace')).toHaveClass(/has-measure/);
  await page.screenshot({ path: test.info().outputPath('kit-trace.png') });
  const box = (await page.locator('#flat').boundingBox())!;
  let hit = '';
  for (let y = 0.2; y < 0.8 && hit !== 'p1'; y += 0.02) {
    for (let x = 0.3; x < 0.8 && hit !== 'p1'; x += 0.04) {
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
      hit = (await page.locator('#flat').getAttribute('data-selected')) ?? '';
    }
  }
  expect(hit).toBe('p1');
  await expect(page.locator('#partList [aria-selected=true]')).toHaveText('Part 1');
  await expect(page.locator('#scopeText')).toHaveText('Part 1');
  await expect(page.locator('.trace')).toHaveClass(/has-measure/);

  // reloaded: the arrangement is back
  const stored = () => page.evaluate((key) => new Promise<number | null>((resolve) => {
    const rq = indexedDB.open('gridfinity-tool-studio-kits');
    rq.onsuccess = () => {
      const one = rq.result.transaction('uploads').objectStore('uploads').get(key);
      one.onsuccess = () => {
        resolve(one.result?.layout?.placements[1]?.rot ?? null);
        rq.result.close();
      };
    };
  }), id);
  await expect.poll(stored).toBeCloseTo(turned, 6);
  await page.reload();
  await open(page);
  await page.locator('#tool').selectOption(id);
  await expect.poll(async () => (await lastLayout(page))?.placements[1]?.rot).toBeCloseTo(turned, 6);
  const back = (await lastLayout(page))!.placements;
  for (const i of [0, 1]) {
    expect(back[i]!.x).toBeCloseTo(arranged[i]!.x, 6);
    expect(back[i]!.y).toBeCloseTo(arranged[i]!.y, 6);
    expect(back[i]!.rot).toBeCloseTo(arranged[i]!.rot, 6);
  }
  await expect(page.locator('#layoutPane')).toBeVisible();
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 60_000 });
  expect(errors).toEqual([]);
});

test('a kit\'s Mixed controls don\'t carry over to a tool without a layout of its own', async ({ page }) => {
  const errors = pageErrors(page);
  await openKit(page);
  // part 2 without a finger slot: with no part selected, Grab slot is Mixed
  await page.locator('#partList [role=option]').nth(1).click();
  await page.locator('#slotOn').uncheck();
  await page.locator('#scopeClear').click();
  await expect(page.locator('#slotOn')).toHaveClass(/mixed/);
  await expect(page.locator('#clearanceV')).not.toHaveText('Mixed');
  // a preset takes the inspector's own values again: its finger slot is on and nothing reads Mixed
  await page.locator('#tool').selectOption('groovejoint');
  await expect(page.locator('#slotOn')).toBeChecked();
  await expect(page.locator('#slotOn')).not.toHaveClass(/mixed/);
  for (const id of ['clearanceV', 'slotDV', 'slotFracV', 'depthV']) await expect(page.locator(`#${id}`)).not.toHaveText('Mixed');
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 60_000 });
  expect(errors).toEqual([]);
});

test('an upload saved by the single-tool version is carried over, and left for that version', async ({ page }) => {
  const errors = pageErrors(page);
  await open(page);
  // a schema-1 record in the old database, as the single-tool version saved it
  const p = JSON.parse(readFileSync(here('../../tests/fixtures/web-presets/stripper.json'), 'utf-8'));
  await page.evaluate(async (p) => {
    const sheetViewJpeg = await (await fetch('presets/studfinder-sheet.jpg')).blob();
    const record = {
      id: 'up-legacy1', label: 'Old stripper', sym: false, outline: p.outline_mm, crop: p.crop_mm, up2sheet: p.up2sheet,
      symmetry: { outline: p.symmetric_outline_mm, score: p.symmetry_score, axisDeg: 0, offset: 0 },
      sheetViewJpeg, sheetBox: p.sheet_box_mm, schema: 1, created: 1, used: 1,
    };
    await new Promise<void>((resolve, reject) => {
      const rq = indexedDB.open('gridfinity-tool-studio');
      rq.onupgradeneeded = () => rq.result.createObjectStore('uploads');
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        const tx = rq.result.transaction('uploads', 'readwrite');
        tx.objectStore('uploads').put(record, record.id);
        tx.oncomplete = () => { rq.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, p);
  await page.reload();
  await open(page);
  // it is in the menu, and builds
  await expect(page.locator('#tool optgroup[label="Your uploads"] option')).toHaveText(['Old stripper']);
  await page.locator('#tool').selectOption('up-legacy1');
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 60_000 });
  // the old database still has it as it was, so an old tab still open keeps working (and deletes nothing)
  const keys = (db: string) => page.evaluate((db) => new Promise<{ key: string; schema: unknown }[]>((resolve, reject) => {
    const rq = indexedDB.open(db);
    rq.onerror = () => reject(rq.error);
    rq.onsuccess = () => {
      const all = rq.result.transaction('uploads').objectStore('uploads').getAll();
      const ks = rq.result.transaction('uploads').objectStore('uploads').getAllKeys();
      all.onsuccess = () => ks.onsuccess = () => {
        resolve((ks.result as string[]).map((key, i) => ({ key, schema: (all.result[i] as { schema: unknown }).schema })));
        rq.result.close();
      };
    };
  }), db);
  expect(await keys('gridfinity-tool-studio')).toEqual([{ key: 'up-legacy1', schema: 1 }]);
  expect(await keys('gridfinity-tool-studio-kits')).toEqual([{ key: 'up-legacy1', schema: 2 }]);
  // removing it removes it from both, so it isn't carried over again
  await page.locator('#rmBtn').click();
  await expect(page.locator('#tool optgroup[label="Your uploads"] option')).toHaveCount(0);
  await expect.poll(() => keys('gridfinity-tool-studio')).toEqual([]);
  await page.reload();
  await open(page);
  await expect(page.locator('#tool optgroup[label="Your uploads"] option')).toHaveCount(0);
  expect(errors).toEqual([]);
});
