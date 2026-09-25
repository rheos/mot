// Issue #43 — the vector arm drops hits beyond the relevance floor. Issue #65 — that floor belongs
// to conversation_vec only; the other stores have none until one is measured for them.
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

  describe('the floor is per store (#65)', () => {
    const keys = [
      'VECTOR_DISTANCE_FLOOR',
      'VECTOR_DISTANCE_FLOOR_ENTITY_VEC',
      'VECTOR_DISTANCE_FLOOR_MEMORY_ITEMS_VEC',
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    afterEach(() => {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      getDb().prepare('DELETE FROM entity_vec').run();
      getDb().prepare('DELETE FROM memory_items_vec').run();
    });

    it('only conversation_vec carries the measured 0.76; the other stores have no floor', () => {
      expect(distanceFloor('conversation_vec')).toBe(0.76);
      expect(distanceFloor()).toBe(0.76); // the pre-#65 bare call still answers for turns
      for (const t of ['entity_vec', 'memory_items_vec', 'session_digest_vec']) {
        expect(distanceFloor(t)).toBe(Number.POSITIVE_INFINITY);
      }
    });

    it('an entity KNN keeps a hit the turn floor would have dropped', () => {
      vecInsert(getDb(), 'entity_vec', 'e1', axisVec(1)); // orthogonal: distance sqrt(2) > 0.76
      vecInsert(getDb(), 'conversation_vec', 1, axisVec(1));
      expect(vecKnn(getDb(), 'conversation_vec', axisVec(0), 10)).toEqual([]);
      expect(vecKnn(getDb(), 'entity_vec', axisVec(0), 10).map((h) => h.id)).toEqual(['e1']);
    });

    it('the global VECTOR_DISTANCE_FLOOR does not reach the other stores', () => {
      vecInsert(getDb(), 'memory_items_vec', 7, axisVec(1));
      process.env.VECTOR_DISTANCE_FLOOR = '0.1';
      expect(vecKnn(getDb(), 'memory_items_vec', axisVec(0), 10).length).toBe(1);
    });

    it('a per-store floor is honoured once set, and junk falls back to no floor', () => {
      vecInsert(getDb(), 'entity_vec', 'e1', axisVec(1));
      process.env.VECTOR_DISTANCE_FLOOR_ENTITY_VEC = '0.5';
      expect(distanceFloor('entity_vec')).toBe(0.5);
      expect(vecKnn(getDb(), 'entity_vec', axisVec(0), 10)).toEqual([]);
      process.env.VECTOR_DISTANCE_FLOOR_ENTITY_VEC = 'abc';
      expect(distanceFloor('entity_vec')).toBe(Number.POSITIVE_INFINITY);
      expect(vecKnn(getDb(), 'entity_vec', axisVec(0), 10).length).toBe(1);
    });
  });
});
