import { describe, expect, it } from 'vitest';
import { PipelineClient, type Port } from './client';
import { PipelineError, type Request, type Response } from './protocol';
import { DEFAULTS } from '../params';

/** A port that holds requests until the test answers them. */
function fakePort() {
  const sent: Request[] = [];
  let listener: (e: MessageEvent) => void = () => {};
  const port: Port = {
    postMessage: (m) => { sent.push(m as Request); },
    addEventListener: (_t, l) => { listener = l; },
  };
  const reply = (res: Response) => listener({ data: res } as MessageEvent);
  return { port, sent, reply };
}

describe('PipelineClient', () => {
  it('drops responses to superseded requests of the same kind', async () => {
    const { port, sent, reply } = fakePort();
    const c = new PipelineClient(port);
    const first = c.request('outline', { params: DEFAULTS });
    const second = c.request('outline', { params: { ...DEFAULTS, rot: 10 } });
    const [a, b] = sent as Request<'outline'>[];
    expect([a!.version, b!.version]).toEqual([1, 2]);
    // the newer answer arrives first, then the stale one
    reply({ id: b!.id, kind: 'outline', version: 2, ok: false, code: 'internal', error: 'boom' });
    reply({ id: a!.id, kind: 'outline', version: 1, ok: true, result: {} as never });
    await expect(second).rejects.toBeInstanceOf(PipelineError);
    await expect(first).resolves.toBeUndefined();
  });

  it('versions each kind separately', async () => {
    const { port, sent, reply } = fakePort();
    const c = new PipelineClient(port);
    const tools = c.request('listTools', {});
    const outline = c.request('outline', { params: DEFAULTS });
    reply({ id: sent[1]!.id, kind: 'outline', version: 1, ok: true, result: { nx: 2 } as never });
    reply({ id: sent[0]!.id, kind: 'listTools', version: 1, ok: true, result: [] });
    await expect(outline).resolves.toEqual({ nx: 2 });
    await expect(tools).resolves.toEqual([]);
  });

  it('passes typed errors through', async () => {
    const { port, sent, reply } = fakePort();
    const c = new PipelineClient(port);
    const r = c.request('build', { params: DEFAULTS });
    reply({ id: sent[0]!.id, kind: 'build', version: 1, ok: false, code: 'not-implemented', error: 'later' });
    await expect(r).rejects.toMatchObject({ code: 'not-implemented', message: 'later' });
  });
});
