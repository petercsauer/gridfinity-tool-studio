// End-to-end against a deployed site (run with BASE_URL=https://… npx playwright test). Real network: the
// model comes from Hugging Face and the onnxruntime wasm from jsDelivr, so the production headers (COOP, COEP,
// CSP) are exercised for real. Fails on any page error, console error or CSP violation.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const STRIPPER = fileURLToPath(new URL('../../assets/presets/stripper.jpg', import.meta.url));

/** Page errors, console errors (page and workers) and CSP violations seen so far. */
function problems(page: Page): string[] {
  const out: string[] = [];
  page.on('pageerror', (e) => out.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') out.push(`console: ${m.text()}`); });
  page.on('worker', (w) => w.on('console', (m) => { if (m.type() === 'error') out.push(`worker console: ${m.text()}`); }));
  page.on('requestfailed', (r) => out.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  return out;
}

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.locator('#tool > option')).toHaveCount(4);
  await expect(page.locator('.trace')).toHaveClass(/ready/);
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator('#exp')).toHaveText(/Export STL/);
}

/** Upload a photo, accept the model download if asked, and wait until it is traced. */
async function upload(page: Page, file: string, name: string): Promise<void> {
  const msg = page.locator('#upMsg');
  const before = await msg.textContent();
  await page.locator('#upFile').setInputFiles(file);
  // the consent prompt (first upload only), then the result; stop at the first error instead of timing out
  const state = async () => {
    if (await page.locator('#consent').isVisible()) return 'consent';
    const cls = (await msg.getAttribute('class')) ?? '';
    return /\b(ok|error)\b/.test(cls) && (await msg.textContent()) !== before ? 'done' : 'busy';
  };
  await expect.poll(state, { timeout: 120_000 }).not.toBe('busy');
  if ((await state()) === 'consent') await page.locator('#consentYes').click();
  await expect.poll(state, { timeout: 420_000 }).toBe('done');
  await expect(page.locator('#upMsg')).toHaveText(new RegExp(`Added “${name}”`));
  await expect(page.locator('#exp')).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator('#exp')).toHaveText(/Export STL/);
  await expect.poll(() => tracePixels(page)).toBeGreaterThan(10_000);
}

const tracePixels = (page: Page) => page.locator('#flat').evaluate((c: HTMLCanvasElement) => {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
  return n;
});

test('the deployed site sends the production headers', async ({ request }) => {
  const res = await request.get('./');
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h['cross-origin-opener-policy']).toBe('same-origin');
  expect(h['cross-origin-embedder-policy']).toBe('credentialless');
  expect(h['content-security-policy']).toContain("default-src 'self'");
  expect(h['content-security-policy']).not.toContain("'unsafe-eval'");
  expect(h['x-content-type-options']).toBe('nosniff');
});

test('presets trace, the bin builds and Export saves a valid STL', async ({ page }) => {
  const seen = problems(page);
  await open(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect.poll(() => tracePixels(page)).toBeGreaterThan(10_000);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#exp').click()]);
  expect(download.suggestedFilename()).toBe('gridfinity_needlenose.stl');
  const stl = readFileSync((await download.path())!);
  const triangles = stl.readUInt32LE(80);
  expect(triangles).toBeGreaterThan(1000);
  expect(stl.length).toBe(84 + 50 * triangles);
  await page.screenshot({ path: test.info().outputPath('live-preset.png') });
  expect(seen).toEqual([]);
});

test('uploads download the real model and are traced (JPEG, then HEIC)', async ({ page }) => {
  test.setTimeout(600_000);
  const seen = problems(page);
  const hosts = new Set<string>();
  page.context().on('request', (r) => hosts.add(new URL(r.url()).host));
  page.on('close', () => { if (seen.length) console.log(seen.join('\n')); });
  await open(page);
  await upload(page, STRIPPER, 'stripper');
  await page.screenshot({ path: test.info().outputPath('live-upload.png') });
  // HEIC goes through heic-to on the UI thread (Chrome can't decode it), with its own blob worker
  const heic = join(tmpdir(), 'gts-live-stripper.heic');
  try { execFileSync('sips', ['-s', 'format', 'heic', STRIPPER, '--out', heic], { stdio: 'ignore' }); } catch { /* no sips */ }
  if (existsSync(heic)) await upload(page, heic, 'gts-live-stripper');
  console.log(`hosts contacted: ${[...hosts].sort().join(', ')}`);
  expect(seen).toEqual([]);
});
