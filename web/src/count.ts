// Anonymous usage counts. Each event fetches a tiny static file from this site (public/e/<event>.txt), so it
// shows up as a request path in Cloudflare's request analytics (scripts/event-counts.sh reads them). Nothing
// else is sent: no cookies, no IDs, no third party, and nothing about the photo.

export type CountEvent =
  | 'upload-start' | 'model-yes' | 'model-no'
  | 'upload-ok' | 'upload-no-sheet' | 'upload-no-tool' | 'upload-cut-off' | 'upload-error'
  | 'export-stl' | 'export-svg' | 'export-dxf';

export function count(event: CountEvent): void {
  if (location.protocol !== 'https:') return; // only the deployed site, not local builds and tests
  void fetch(new URL(`e/${event}.txt`, document.baseURI), { cache: 'no-store', credentials: 'omit', keepalive: true })
    .catch(() => {});
}
