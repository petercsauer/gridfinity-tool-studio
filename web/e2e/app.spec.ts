// End-to-end: presets, the 2D trace, the layout editor, the 3D build and STL export, and the upload flow
// (model consent, tracing, persistence across reloads, removal, errors). The 88 MB model and the onnxruntime wasm are served
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

/** Record the layout sent with every outline request (null when the kit's initial layout is used). */
async function recordOutlines(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { outlines: unknown[] };
    w.outlines = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, msg: { kind?: string; layout?: unknown }, ...rest: never[]) {
      if (msg?.kind === 'outline') w.outlines.push(msg.layout ?? null);
      return (post as (...a: unknown[]) => void).call(this, msg, ...rest);
    };
  });
}
type SentLayout = { placements: { x: number; y: number; rot: number }[] } | null;
const lastLayout = (page: Page) => page.evaluate(() => (window as unknown as { outlines: SentLayout[] }).outlines.at(-1) ?? null);
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
    const rq = indexedDB.open('gridfinity-tool-studio');
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
