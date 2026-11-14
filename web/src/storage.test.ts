import { describe, expect, it } from 'vitest';
import type { Ring, Vec2 } from './geometry/pocket';
import { MAX_UPLOADS, migrate, overflow, SCHEMA } from './storage';
import { centroid } from './vision/symmetry';

describe('upload storage cap', () => {
  it('drops the least recently used uploads beyond the cap', () => {
    const list = Array.from({ length: MAX_UPLOADS + 2 }, (_, i) => ({ id: `u${i}`, used: 100 - i }));
    expect(overflow(list)).toEqual([`u${MAX_UPLOADS + 1}`, `u${MAX_UPLOADS}`]);
  });

  it('keeps everything within the cap', () => {
    expect(overflow([{ id: 'a', used: 1 }, { id: 'b', used: 2 }], 2)).toEqual([]);
  });
});

/** A closed rectangle ring `w` x `h` mm centred on (cx, cy). */
const rect = (w: number, h: number, cx = 0, cy = 0): Ring =>
  ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]] as Vec2[])
    .map(([x, y]): Vec2 => [x + cx, y + cy]);

/** A schema-1 record: one tool, as uploads were stored before kits. */
const schema1 = (id: string, outline: Ring, sym: boolean) => ({
  schema: 1,
  id,
  label: `Tool ${id}`,
  sym,
  outline,
  crop: [60, 90],
  up2sheet: [[1, 0, 100], [0, 1, 140]],
  symmetry: { outline: rect(42, 82), score: 0.93, axisDeg: 2, offset: 0.5 },
  sheetViewJpeg: new Blob([], { type: 'image/jpeg' }),
  sheetBox: [10, 15, 205, 265],
  created: 1000,
  used: 2000,
});

describe('migrating stored uploads', () => {
  it('turns a schema-1 record into a one-part kit, keeping what the user had', () => {
    const old = schema1('up-1', rect(40, 80, 1, -2), true);
    const u = migrate(old)!;
    expect(u.schema).toBe(SCHEMA);
    expect(u).toMatchObject({ id: 'up-1', label: 'Tool up-1', sym: true, created: 1000, used: 2000, sheetBox: old.sheetBox });
    expect(u.sheetViewJpeg).toBe(old.sheetViewJpeg);
    expect(u.layout).toBeUndefined();
    expect(u.parts).toHaveLength(1);
    expect(u.parts[0]).toEqual({
      id: 'p1',
      outline: old.outline,
      crop: old.crop,
      up2sheet: old.up2sheet,
      symmetry: { ...old.symmetry, centre: centroid(old.outline) },
    });
    expect(u.parts[0]!.symmetry.centre[0]).toBeCloseTo(1, 9);
    expect(u.parts[0]!.symmetry.centre[1]).toBeCloseTo(-2, 9);
    expect(u).not.toHaveProperty('outline');
  });

  it('keeps a current record and its layout as they are', () => {
    const cur = migrate(schema1('up-2', rect(40, 80), false))!;
    const layout = { placements: [{ part: 'p1', x: 3, y: -4, rot: 90, sym: false, clearance: 1, slotOn: true, slotR: 12, slotOver: 8, slotFrac: 0.5, depth: 20 }] };
    const again = migrate({ ...cur, layout })!;
    expect(again).toEqual({ ...cur, layout });
  });

  it.each([
    ['nothing', undefined],
    ['a string', 'up-x'],
    ['an unknown schema', { ...schema1('up-3', rect(40, 80), false), schema: 7 }],
    ['a schema-1 record without its outline', { ...schema1('up-3', rect(40, 80), false), outline: undefined }],
    ['a schema-1 record without its sheet image', { ...schema1('up-3', rect(40, 80), false), sheetViewJpeg: 'x' }],
    ['a kit without parts', { ...migrate(schema1('up-3', rect(40, 80), false))!, parts: [] }],
    ['a kit with a broken part', { ...migrate(schema1('up-3', rect(40, 80), false))!, parts: [{ id: 'p1' }] }],
  ])('gives null for %s', (_, v) => {
    expect(migrate(v)).toBeNull();
  });

  it('migrates each record on its own', () => {
    const a = schema1('up-a', rect(40, 80), true);
    const b = { ...schema1('up-b', rect(20, 30, 5, 5), false), created: 3000, used: 4000 };
    const bad = { ...schema1('up-c', rect(10, 10), false), up2sheet: 'no' };
    const [ma, mbad, mb] = [a, bad, b].map(migrate);
    expect(mbad).toBeNull();
    expect(ma).toMatchObject({ id: 'up-a', sym: true, created: 1000, used: 2000 });
    expect(mb).toMatchObject({ id: 'up-b', sym: false, created: 3000, used: 4000 });
    expect(ma!.parts[0]!.outline).toBe(a.outline);
    expect(mb!.parts[0]!.outline).toBe(b.outline);
  });
});
