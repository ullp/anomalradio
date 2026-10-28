/**
 * Broadcast clock.
 *
 * The on-air position is a pure function of wall-clock time (§3.1 of the offer), which makes it
 * testable without waiting: passing a future timestamp is the same as waiting for it. The
 * fixture library is two 800 ms tracks, so a whole rotation takes 1.6 s.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';

let ctx;
let stateAt;

const CYCLE_MS = 1600; // 2 fixture tracks × 800 ms
const TRACK_MS = 800;
// One fixed base timestamp for the whole file: offsets are then exactly comparable, with no
// millisecond drift between two `Date.now()` calls.
const BASE = Date.now();

before(async () => {
  ctx = await startTestServer();
  stateAt = (offsetMs) => ctx.serverModule.broadcastState(BASE + offsetMs);
});

after(async () => {
  await ctx?.close();
});

describe('broadcast clock — a pure function of time', () => {
  it('is deterministic: the same instant always yields the same state', () => {
    const stamp = Date.now();
    const first = ctx.serverModule.broadcastState(stamp);
    const second = ctx.serverModule.broadcastState(stamp);
    assert.equal(first.now.track.id, second.now.track.id);
    assert.equal(first.now.elapsedMs, second.now.elapsedMs);
    assert.equal(first.station.listeners, second.station.listeners);
    assert.equal(first.cycle.positionMs, second.cycle.positionMs);
  });

  it('repeats after exactly one full rotation', () => {
    const now = stateAt(0);
    const later = stateAt(CYCLE_MS);
    assert.equal(later.now.track.id, now.now.track.id, 'one cycle later the same track is on air');
    assert.equal(later.now.elapsedMs, now.now.elapsedMs);
    assert.equal(later.cycle.positionMs, now.cycle.positionMs);
  });

  it('advances one track at a time, following the library order cyclically', () => {
    const order = ctx.library.tracks.map((track) => track.id);
    const successorOf = (id) => order[(order.indexOf(id) + 1) % order.length];

    const sequence = [];
    for (let offset = 0; offset < CYCLE_MS; offset += TRACK_MS / 2) {
      const id = stateAt(offset).now.track.id;
      if (sequence[sequence.length - 1] !== id) sequence.push(id);
    }

    // An arbitrary "now" can land anywhere in the rotation, so the sequence must be a cyclic
    // rotation of the library order — every step must be the next track in the cycle.
    assert.ok(sequence.length >= 2, 'the rotation moves during one cycle');
    for (let i = 1; i < sequence.length; i += 1) {
      assert.equal(
        sequence[i],
        successorOf(sequence[i - 1]),
        `${sequence[i - 1]} must be followed by its successor`,
      );
    }
  });

  it('wraps around to the first track after the last one', () => {
    const first = ctx.library.tracks[0];
    const last = ctx.library.tracks[ctx.library.tracks.length - 1];
    const onLast = [...Array(CYCLE_MS / 100).keys()]
      .map((i) => stateAt(i * 100))
      .find((state) => state.now.track.id === last.id);
    assert.ok(onLast, 'the last track of the rotation is reached');
    assert.equal(onLast.next.track.id, first.id, 'after the last track comes the first');
  });
});

describe('broadcast clock — internal consistency', () => {
  it('reports a progress ratio inside the track', () => {
    for (let offset = 0; offset < CYCLE_MS; offset += 100) {
      const state = stateAt(offset);
      assert.ok(
        state.now.progress >= 0 && state.now.progress < 1,
        `progress ${state.now.progress} out of range`,
      );
      assert.equal(state.now.elapsedMs + state.now.remainingMs, state.now.track.durationMs);
    }
  });

  it('chains history and now-playing without a gap or overlap', () => {
    for (const offset of [0, 350, 900, 1400]) {
      const state = stateAt(offset);
      assert.equal(
        Date.parse(state.history[0].playedAt) + state.history[0].track.durationMs,
        Date.parse(state.now.startedAt),
        'the previous track must end exactly when the current one starts',
      );
      assert.equal(
        Date.parse(state.next.startsAt),
        Date.parse(state.now.startedAt) + state.now.track.durationMs,
        'the next track must start exactly when the current one ends',
      );
    }
  });

  it('lists history newest first', () => {
    const state = stateAt(5000);
    const stamps = state.history.map((entry) => Date.parse(entry.playedAt));
    for (let i = 1; i < stamps.length; i += 1) {
      assert.ok(stamps[i - 1] > stamps[i], 'history is ordered from most recent to oldest');
    }
    assert.ok(stamps[stamps.length - 1] < Date.parse(state.now.startedAt));
  });

  it('chains every history entry to the one after it, with no gap', () => {
    const state = stateAt(10_000);
    for (let i = 1; i < state.history.length; i += 1) {
      const previous = state.history[i - 1];
      const older = state.history[i];
      assert.equal(
        Date.parse(older.playedAt) + older.track.durationMs,
        Date.parse(previous.playedAt),
        `history entry ${i} must end exactly when entry ${i - 1} starts`,
      );
    }
  });

  it('alternates through a two-track rotation', () => {
    // A small catalogue is the honest stress case: the scheduler must cycle, not stall.
    const state = stateAt(10_000);
    const [first, second] = ctx.library.tracks.map((track) => track.id);
    const sequence = [state.now.track.id, ...state.history.map((entry) => entry.track.id)];
    for (let i = 1; i < sequence.length; i += 1) {
      assert.notEqual(sequence[i], sequence[i - 1], 'the same track never plays twice in a row');
      assert.ok([first, second].includes(sequence[i]), 'only library tracks are scheduled');
    }
  });

  it('reports a plausible listener count', () => {
    for (const offset of [0, 1234, 60_000, 3_600_000]) {
      const listeners = stateAt(offset).station.listeners;
      assert.ok(
        Number.isInteger(listeners) && listeners > 0,
        `listeners ${listeners} must be a positive integer`,
      );
    }
  });
});
