import { describe, expect, it } from 'vitest';
import { MAX_UPLOADS, overflow } from './storage';

describe('upload storage cap', () => {
  it('drops the least recently used uploads beyond the cap', () => {
    const list = Array.from({ length: MAX_UPLOADS + 2 }, (_, i) => ({ id: `u${i}`, used: 100 - i }));
    expect(overflow(list)).toEqual([`u${MAX_UPLOADS + 1}`, `u${MAX_UPLOADS}`]);
  });

  it('keeps everything within the cap', () => {
    expect(overflow([{ id: 'a', used: 1 }, { id: 'b', used: 2 }], 2)).toEqual([]);
  });
});
