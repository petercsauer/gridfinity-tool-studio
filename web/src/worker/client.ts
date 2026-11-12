// UI-side wrapper around the pipeline worker: one promise per request, and responses
// to superseded requests (an older version of the same kind) are dropped.
import { PipelineError, type Kind, type Request, type Requests, type Response, type Results } from './protocol';

/** The part of a Worker (or MessagePort) the client needs; tests pass a fake. */
export interface Port {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
}

interface Pending {
  kind: Kind;
  version: number;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

export class PipelineClient {
  private nextId = 1;
  private readonly latest = new Map<Kind, number>();
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly port: Port) {
    port.addEventListener('message', (e) => this.receive(e.data as Response));
  }

  /** Sends a request. Resolves with the result, or with `undefined` if a newer request of
   * the same kind was sent before this one finished. Rejects with a PipelineError. */
  request<K extends Kind>(kind: K, body: Requests[K], transfer: Transferable[] = []): Promise<Results[K] | undefined> {
    const version = (this.latest.get(kind) ?? 0) + 1;
    this.latest.set(kind, version);
    const id = this.nextId++;
    const msg = { ...body, id, kind, version } as Request<K>;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind, version, resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage(msg, transfer);
    });
  }

  /** Whether `version` is still the newest request of its kind. */
  isCurrent(kind: Kind, version: number): boolean {
    return this.latest.get(kind) === version;
  }

  private receive(res: Response): void {
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    if (!this.isCurrent(p.kind, p.version)) p.resolve(undefined);
    else if (res.ok) p.resolve(res.result);
    else p.reject(new PipelineError(res.code, res.error));
  }
}
