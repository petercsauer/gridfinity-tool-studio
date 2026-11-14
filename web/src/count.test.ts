import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { uploadErrorEvent, type CountEvent } from './count';
import { isOutOfMemory, PipelineError } from './worker/protocol';

describe('upload error buckets', () => {
  it.each([
    [new PipelineError('no-sheet', 'x'), false, 'upload-no-sheet'],
    [new PipelineError('no-tool', 'x'), false, 'upload-no-tool'],
    [new PipelineError('cut-off', 'x'), false, 'upload-cut-off'],
    [new PipelineError('too-many-parts', 'x'), false, 'upload-too-many'],
    [new PipelineError('invalid', 'This file could not be read as an image.'), true, 'upload-error-decode'],
    [new PipelineError('invalid', 'This HEIC photo could not be converted.'), true, 'upload-error-decode'],
    [new PipelineError('model', "Couldn't download the background-removal model (HTTP 503)."), false, 'upload-error-model'],
    [new PipelineError('memory', 'This device ran out of memory.'), false, 'upload-error-memory'],
    [new RangeError('Array buffer allocation failed'), true, 'upload-error-memory'],
    [new PipelineError('internal', 'Processing failed: RuntimeError: Aborted(OOM)'), false, 'upload-error-memory'],
    [new PipelineError('internal', 'Processing failed: TypeError: x is undefined'), false, 'upload-error'],
    [new PipelineError('invalid', 'This file could not be read as an image.'), false, 'upload-error'],
    [new Error('boom'), false, 'upload-error'],
  ] as const)('%s (decoding: %s) counts as %s', (e, decoding, event) => {
    expect(uploadErrorEvent(e, decoding)).toBe(event);
  });

  it.each([
    'RangeError: Array buffer allocation failed',
    'RuntimeError: Aborted(OOM). Build with -sASSERTIONS for more info.',
    'Cannot enlarge memory arrays to size 2147483648 bytes',
    'WebAssembly.Memory.grow(): Maximum memory size exceeded',
    "Error: [WebGPU] Kernel failed: Failed to allocate a buffer of size 33554432",
    'GPU out of memory',
  ])('recognises out of memory: %s', (msg) => {
    expect(isOutOfMemory(new Error(msg))).toBe(true);
  });

  it.each(['RangeError: Invalid array length', 'Maximum call stack size exceeded', 'memory access out of bounds'])(
    'does not mistake %s for out of memory', (msg) => {
      expect(isOutOfMemory(new Error(msg))).toBe(false);
    });

  it('counts too many parts in its own bucket, with a public/e file and an event-counts.sh row', () => {
    expect(uploadErrorEvent(new PipelineError('too-many-parts', 'x'), false)).toBe('upload-too-many');
    const file = fileURLToPath(new URL('../public/e/upload-too-many.txt', import.meta.url));
    expect(readFileSync(file, 'utf-8').trim()).toBe('ok');
    const script = readFileSync(fileURLToPath(new URL('../../scripts/event-counts.sh', import.meta.url)), 'utf-8');
    expect(script).toContain('"upload-too-many"');
  });

  it('has a public/e file and an event-counts.sh row for every event', () => {
    const src = readFileSync(fileURLToPath(new URL('./count.ts', import.meta.url)), 'utf-8');
    const type = /export type CountEvent =([^;]+);/.exec(src)![1]!;
    const events = [...type.matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as CountEvent);
    expect(events.length).toBeGreaterThan(10);
    const script = readFileSync(fileURLToPath(new URL('../../scripts/event-counts.sh', import.meta.url)), 'utf-8');
    for (const e of events) {
      const file = fileURLToPath(new URL(`../public/e/${e}.txt`, import.meta.url));
      expect(existsSync(file), e).toBe(true);
      expect(readFileSync(file, 'utf-8').trim()).toBe('ok');
      expect(script).toContain(`"${e}"`);
    }
  });
});
