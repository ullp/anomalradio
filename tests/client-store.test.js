/**
 * Client store: the ★ list and the server (M4).
 *
 * The store is browser code, so this file gives it the smallest browser it can run in: a
 * `localStorage`, a `document.cookie` and a `fetch` that records what it was asked for. What it
 * pins is the part that breaks quietly — that toggling a star reaches the right endpoint with the
 * right method, that a sync adopts the server's list, and that neither ever blocks the UI.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let store;

before(async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.document = { cookie: '' };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ signedIn: false, count: 0, tracks: [], shares: 7 }),
    };
  };
  store = await import('../public/assets/js/store.js');
});

after(() => {
  for (const key of ['localStorage', 'document', 'fetch']) delete globalThis[key];
});

const track = { id: 'ar_test0000000000', title: 'Test', artist: 'A', durationMs: 1000 };

describe('client favourites store', () => {
  it('stars locally and tells the server', () => {
    assert.equal(store.toggleFavourite(track), true);
    assert.equal(store.isFavourite(track.id), true);

    assert.equal(calls.at(-1).url, '/api/favourites');
    assert.equal(calls.at(-1).method, 'POST');
    assert.deepEqual(JSON.parse(calls.at(-1).body), { trackId: track.id });
  });

  it('unstars with a DELETE', () => {
    assert.equal(store.toggleFavourite(track), false);
    assert.equal(store.isFavourite(track.id), false);
    assert.equal(calls.at(-1).method, 'DELETE');
    assert.match(calls.at(-1).url, /\/api\/favourites\/ar_test0000000000$/);
  });

  it('adopts the server list on sync, slimmed to what the UI needs', () => {
    store.setFavourites([{ ...track, id: 'ar_fromserver00000', storageKey: 'tracks/secret.mp3' }]);
    assert.equal(store.favourites().length, 1);
    assert.equal(store.favourites()[0].id, 'ar_fromserver00000');
    assert.equal(store.favourites()[0].storageKey, undefined, 'private fields are dropped');
    assert.deepEqual(Object.keys(store.favourites()[0]).sort(), [
      'album',
      'artist',
      'bpm',
      'currency',
      'durationMs',
      'genre',
      'id',
      'priceCents',
      'title',
      'year',
    ]);
  });

  it('never blocks the UI on the network', () => {
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    assert.equal(store.toggleFavourite({ ...track, id: 'ar_offline0000000' }), true);
    assert.equal(store.isFavourite('ar_offline0000000'), true, 'the star still lands locally');
  });
});
