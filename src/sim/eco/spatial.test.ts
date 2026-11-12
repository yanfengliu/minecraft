import { describe, expect, it } from 'vitest';
import { SpatialHash } from './spatial';
import { SPECIES, bit } from './species';
import { Animal, Group } from './types';

describe('the grid animals are found through', () => {
  it('files an animal by the column it has just entered, not the one it left', () => {
    const hash = new SpatialHash(64, 64);
    const deer = SPECIES[0]!;
    const a = new Animal(deer, new Group(1, deer));
    Object.assign(a, { x: 15.9, z: 8.5, cx: 15, cz: 8 });
    hash.insert(a);
    const seen = (x: number, radius: number): Animal | null => hash.nearest(x, 8.5, radius, bit(deer.index), null, -1);
    expect(seen(8, 8)).toBe(a);

    // It steps over the edge of a cell, as the movers do it: the column first, then the grid, then the position.
    a.cx = 16;
    hash.moved(a);
    a.x = 16.05;
    // A search whose box lies wholly in the cell it is now in must find it. (Filed by where it had been, it
    // was missed until it next changed column.)
    expect(seen(24, 8)).toBe(a);
    expect(seen(6, 8)).toBeNull();

    // And back again.
    a.cx = 15;
    hash.moved(a);
    a.x = 15.95;
    expect(seen(8, 8)).toBe(a);
    hash.remove(a);
    expect(seen(8, 8)).toBeNull();
  });
});
