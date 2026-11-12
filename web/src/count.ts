// Anonymous usage counts. Each event fetches a tiny static file from this site (public/e/<event>.txt), so it
// shows up as a request path in Cloudflare's request analytics (scripts/event-counts.sh reads them). Nothing
// else is sent: no cookies, no IDs, no third party, and nothing about the photo.

import { isOutOfMemory, PipelineError } from './worker/protocol';

export type CountEvent =
  | 'upload-start' | 'model-yes' | 'model-no'
  | 'upload-ok' | 'upload-no-sheet' | 'upload-no-tool' | 'upload-cut-off'
  | 'upload-error-decode' | 'upload-error-model' | 'upload-error-memory' | 'upload-error'
  | 'export-stl' | 'export-svg' | 'export-dxf';

/** The event for a failed upload. `decoding` is whether it failed while the photo was being decoded (on the
 * UI thread, before the worker sees it). Out of memory wins over the stage it happened in. */
export function uploadErrorEvent(e: unknown, decoding: boolean): CountEvent {
  const code = e instanceof PipelineError ? e.code : '';
  if (code === 'no-sheet') return 'upload-no-sheet';
  if (code === 'no-tool') return 'upload-no-tool';
  if (code === 'cut-off') return 'upload-cut-off';
  if (code === 'memory' || isOutOfMemory(e)) return 'upload-error-memory';
  if (decoding) return 'upload-error-decode';
  if (code === 'model') return 'upload-error-model';
  return 'upload-error';
}

export function count(event: CountEvent): void {
  if (location.protocol !== 'https:') return; // only the deployed site, not local builds and tests
  void fetch(new URL(`e/${event}.txt`, document.baseURI), { cache: 'no-store', credentials: 'omit', keepalive: true })
    .catch(() => {});
}
