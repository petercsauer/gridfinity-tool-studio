// End-to-end tests against the production build, served by `vite preview` on port 4175.
// Uses the system Chrome (headless) rather than a Playwright-downloaded browser; set CHROME_PATH to override,
// or PW_BUNDLED_CHROMIUM=1 to use Playwright's own Chromium (e.g. in CI after `npx playwright install chromium`).
import { defineConfig } from '@playwright/test';

const PORT = 4175;
// BASE_URL points the tests at a deployed site (e2e/live.spec.ts); then no local server is started
const BASE_URL = process.env.BASE_URL;
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: 'e2e',
  // the live spec only runs against a deployed site, and the local specs only against vite preview
  ...(BASE_URL ? { testMatch: 'live.spec.ts' } : { testIgnore: 'live.spec.ts' }),
  // uploads run IS-Net on WASM (no WebGPU headless): about 20 s each, plus the model load
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL ?? `http://localhost:${PORT}/`,
    headless: true,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    launchOptions: {
      ...(process.env.PW_BUNDLED_CHROMIUM ? {} : { executablePath: chrome }),
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
    },
  },
  webServer: BASE_URL ? undefined : {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
