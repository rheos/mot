// Issue #43 — the vector arm drops hits beyond the relevance floor.
//
// Vectors are FABRICATED with known geometry rather than embedded, so this asserts the floor's
// behaviour without a model download and without depending on any particular corpus.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupVecDb, cleanupTempDb } from './_helpers';

const { dbPath, vecAvail } = setupVecDb('vec-floor');

let vecInsert: typeof import('../../lib/vec').vecInsert;
let vecKnn: typeof import('../../lib/vec').vecKnn;
let distanceFloor: typeof import('../../lib/vec').distanceFloor;
let loadVecExtension: typeof import('../../lib/vec').loadVecExtension;
let getDb: typeof import('../../db/client').getDb;

/** A unit vector pointing along axis `axis`. Two such vectors are sqrt(2) ~ 1.414 apart. */
const axisVec = (axis: number) => {
  const f = new Float32Array(384);
  f[axis] = 1;
  return f;
};
/** A unit vector `t` of the way from axis a toward axis b — lets distance be dialled precisely. */
const between = (a: number, b: number, t: number) => {
  const f = new Float32Array(384);
  f[a] = Math.cos((t * Math.PI) / 2);
  f[b] = Math.sin((t * Math.PI) / 2);
  return f;
};

beforeAll(async () => {
  ({ vecInsert, vecKnn, distanceFloor, loadVecExtension } = await import('../../lib/vec'));
  ({ getDb } = await import('../../db/client'));
  loadVecExtension(getDb());
});
afterAll(() => cleanupTempDb(dbPath));

describe.skipIf(!vecAvail)('relevance floor', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM conversation_vec').run();
    getDb().prepare('DELETE FROM vec_meta').run();
  });

  it('keeps a near neighbour and drops a far one', () => {
    vecInsert(getDb(), 'conversation_vec', 1, between(0, 1, 0.05)); // very close to axis 0
    vecInsert(getDb(), 'conversation_vec', 2, axisVec(1)); // orthogonal — distance sqrt(2)
    const hits = vecKnn(getDb(), 'conversation_vec', axisVec(0), 10);
    expect(hits.map((h) => h.id)).toEqual([1]);
  });

  it('returns nothing when every row is beyond the floor', () => {
    // The honest "nothing relevant exists" case. Returning k plausible rows here is the bug.
    for (const id of [1, 2, 3]) vecInsert(getDb(), 'conversation_vec', id, axisVec(id));
    expect(vecKnn(getDb(), 'conversation_vec', axisVec(100), 10)).toEqual([]);
  });

  it('never returns a hit beyond the floor, whatever k is asked for', () => {
    for (let i = 0; i < 20; i++) vecInsert(getDb(), 'conversation_vec', i, between(0, 1, i / 20));
    const hits = vecKnn(getDb(), 'conversation_vec', axisVec(0), 20);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.distance <= distanceFloor())).toBe(true);
  });

  describe('the floor is tunable without a deploy', () => {
    const saved = process.env.VECTOR_DISTANCE_FLOOR;
    afterEach(() => {
      if (saved === undefined) delete process.env.VECTOR_DISTANCE_FLOOR;
      else process.env.VECTOR_DISTANCE_FLOOR = saved;
    });

    it('a floor above the metric maximum disables filtering entirely', () => {
      for (const id of [1, 2, 3]) vecInsert(getDb(), 'conversation_vec', id, axisVec(id));
      expect(vecKnn(getDb(), 'conversation_vec', axisVec(100), 10)).toEqual([]);
      process.env.VECTOR_DISTANCE_FLOOR = '99';
      expect(vecKnn(getDb(), 'conversation_vec', axisVec(100), 10).length).toBe(3);
    });

    it('is read at call time and falls back to the default on junk', () => {
      for (const junk of ['0', '-1', 'abc', '']) {
        process.env.VECTOR_DISTANCE_FLOOR = junk;
        expect(distanceFloor()).toBe(0.76);
      }
    });
  });
});
