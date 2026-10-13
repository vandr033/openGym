import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkoutSessionError, normalizeWorkoutOperation, normalizeWorkoutRoutineSnapshot,
  parseEventLimit, validateEventCursor
} from '../saas/workout-sessions.js';

const operationId = '123e4567-e89b-42d3-a456-426614174000';
const exerciseId = '123e4567-e89b-42d3-a456-426614174001';
const setId = '123e4567-e89b-42d3-a456-426614174002';

test('event replay cursors and page sizes are bounded and preserve 64-bit sequence values', () => {
  assert.equal(validateEventCursor(undefined), '0');
  assert.equal(validateEventCursor('9223372036854775806'), '9223372036854775806');
  assert.equal(parseEventLimit(undefined), 100);
  assert.equal(parseEventLimit('12'), 12);
  for (const value of ['-1', '1.2', '01', '9223372036854775807']) {
    assert.throws(() => validateEventCursor(value), WorkoutSessionError);
  }
  for (const value of ['0', '101', '1.5']) assert.throws(() => parseEventLimit(value), WorkoutSessionError);
});

test('set normalization retains warmup, drops, unilateral data, assisted load, and fractional effort', () => {
  const command = normalizeWorkoutOperation({
    operationId, type: 'set.create', target: { exerciseId },
    patch: {
      phase: 'WARMUP', weightKg: '60.000', reps: 8, rir: '1.5', done: true,
      details: {
        schemaVersion: 1, mode: 'reps', type: 'dropset', perSide: true, assistedKg: '10.000',
        drops: [{ weightKg: '45.500', reps: 10 }],
        sides: {
          L: { weightKg: '60.125', reps: 8, rir: '1.5', done: true, drops: [{ weightKg: '45.5', reps: 10 }] },
          R: { weightKg: '59.875', reps: 8, rir: '2.0', done: true, drops: [{ weightKg: '45.5', reps: 10 }] }
        }
      }
    }
  });
  assert.equal(command.patch.phase, 'WARMUP');
  assert.equal(command.patch.weightKg, '60');
  assert.equal(command.patch.rir, '1.5');
  assert.deepEqual(command.patch.details.data.drops, [{ weightKg: '45.5', reps: 10 }]);
  assert.equal(command.patch.details.data.sides.L.weightKg, '60.125');
  assert.equal(command.patch.details.data.sides.R.rir, '2');
  assert.equal(command.patch.details.data.assistedKg, '10');
});

test('timed and cardio variants keep duration, speed, distance, RPE, and notes', () => {
  const command = normalizeWorkoutOperation({
    operationId, type: 'set.create', target: { exerciseId },
    patch: {
      phase: 'WORK', durationSeconds: 120, rpe: '7.5', notes: 'incline treadmill',
      details: { schemaVersion: 1, mode: 'cardio', speedKph: '10.50', distanceKm: '3.125', status: 'complete' }
    }
  });
  assert.equal(command.patch.durationSeconds, 120);
  assert.equal(command.patch.rpe, '7.5');
  assert.equal(command.patch.details.data.speedKph, '10.5');
  assert.equal(command.patch.details.data.distanceKm, '3.125');
  assert.equal(command.patch.notes, 'incline treadmill');
});

test('routine snapshots preserve deload, progression, superset, prescription, and planned-set metadata', () => {
  const snapshot = normalizeWorkoutRoutineSnapshot({
    name: 'Light week', deload: true, deloadMetadata: { percent: 50 }, program: { phase: 2 },
    exercises: [{
      exerciseId: 'barbell-row', name: 'Barbell row', routineSlotId: 'row-slot', noProgression: true,
      snapshot: { id: 'barbell-row', sg: 'A', mode: 'reps' }, prescription: { sets: 3, reps: 8 },
      sets: [{ plannedSetSlotId: 'slot-1', phase: 'WARMUP', weightKg: '20.000', reps: 10 }]
    }]
  });
  assert.equal(snapshot.deload, true);
  assert.equal(snapshot.deloadMetadata.percent, 50);
  assert.equal(snapshot.exercises[0].noProgression, true);
  assert.equal(snapshot.exercises[0].snapshot.sg, 'A');
  assert.equal(snapshot.exercises[0].sets[0].plannedSetSlotId, 'slot-1');
});

test('set and structural commands require versions and reject malformed values', () => {
  assert.throws(() => normalizeWorkoutOperation({
    operationId, type: 'set.update', target: { setId }, patch: { reps: 9 }
  }), WorkoutSessionError);
  assert.throws(() => normalizeWorkoutOperation({
    operationId, type: 'set.create', target: { exerciseId }, patch: { weightKg: '1e3' }
  }), WorkoutSessionError);
  assert.throws(() => normalizeWorkoutOperation({
    operationId, type: 'set.create', target: { exerciseId }, patch: { phase: 'SKIPPED' }
  }), WorkoutSessionError);
  assert.throws(() => normalizeWorkoutOperation({
    operationId, type: 'exercise.remove', target: { exerciseId }, patch: {}
  }), WorkoutSessionError);
  assert.equal(normalizeWorkoutOperation({
    operationId, type: 'set.update', target: { setId }, expectedSetVersion: 1, patch: { notes: null }
  }).patch.notes, null, 'set notes can be cleared');
});
