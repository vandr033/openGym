import { createHash, randomUUID } from 'node:crypto';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_LOCK = 'SELECT `id` FROM `WorkoutSession` WHERE `id` = ? FOR UPDATE';
const USER_LOCK = "SELECT `id` FROM `User` WHERE `id` = ? AND `status` = 'ACTIVE' FOR UPDATE";
const GRANT_LOCK = `SELECT grantRow.id
  FROM ClientAccessGrant AS grantRow
  JOIN TrainerClientRelationship AS relationship ON relationship.id = grantRow.relationshipId
  JOIN OrganizationMembership AS membership ON membership.organizationId = relationship.organizationId AND membership.userId = relationship.trainerUserId
  JOIN ClientOrganizationEnrollment AS enrollment ON enrollment.organizationId = relationship.organizationId AND enrollment.clientUserId = relationship.clientUserId
  JOIN Organization AS organization ON organization.id = relationship.organizationId
  JOIN User AS trainer ON trainer.id = relationship.trainerUserId
  JOIN User AS client ON client.id = relationship.clientUserId
  WHERE relationship.trainerUserId = ? AND relationship.clientUserId = ? AND relationship.organizationId = ?
    AND relationship.status = 'ACTIVE' AND membership.status = 'ACTIVE'
    AND membership.role IN ('OWNER', 'ADMIN', 'TRAINER') AND enrollment.status = 'ACTIVE'
    AND organization.status = 'ACTIVE' AND trainer.status = 'ACTIVE' AND client.status = 'ACTIVE'
    AND grantRow.scope = ? AND grantRow.revokedAt IS NULL AND grantRow.expiresAt > CURRENT_TIMESTAMP(3)
  FOR UPDATE`;

export class WorkoutSessionError extends Error {
  constructor(status, message, code, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const fail = (status, message, code, details) => { throw new WorkoutSessionError(status, message, code, details); };
const notFound = () => fail(404, 'not found');
const invalid = message => fail(400, message, 'INVALID_REQUEST');
const conflict = (message, code, details) => fail(409, message, code, details);
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const seqString = value => String(value ?? 0n);

function assertObject(value, message = 'invalid request body') {
  if (!isObject(value)) invalid(message);
}

function assertKeys(value, allowed, message = 'invalid request body') {
  assertObject(value, message);
  if (!onlyKeys(value, allowed)) invalid(message);
}

function uuid(value, field = 'operationId') {
  if (typeof value !== 'string' || !ID.test(value)) invalid(`${field} must be a UUID`);
  return value.toLowerCase();
}

function integer(value, field, min = 0, max = 100000) {
  if (!Number.isInteger(value) || value < min || value > max) invalid(`${field} must be an integer between ${min} and ${max}`);
  return value;
}

function boundedText(value, field, max, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) invalid(`${field} is invalid`);
  return value.trim();
}

function decimal(value, field, max, places = 3, min = 0) {
  if (value == null) return null;
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  const pattern = new RegExp(`^(?:0|[1-9]\\d{0,5})(?:\\.\\d{1,${places}})?$`);
  if (typeof raw !== 'string' || !pattern.test(raw) || Number(raw) < min || Number(raw) > max) {
    invalid(`${field} must be a decimal between ${min} and ${max} with at most ${places} decimal places`);
  }
  const [whole, fraction = ''] = raw.split('.');
  const normalized = fraction.replace(/0+$/, '');
  return normalized ? `${whole}.${normalized}` : whole;
}

function cleanJson(value, field, maxBytes, maxDepth = 8) {
  let nodes = 0;
  function walk(item, depth) {
    if (++nodes > 5000 || depth > maxDepth) invalid(`${field} is too complex`);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (item.length > 5000) invalid(`${field} contains an oversized string`);
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid(`${field} contains an invalid number`);
      return item;
    }
    if (Array.isArray(item)) {
      if (item.length > 500) invalid(`${field} contains too many items`);
      return item.map(child => walk(child, depth + 1));
    }
    if (!isObject(item)) invalid(`${field} must contain JSON values only`);
    const out = {};
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid(`${field} contains a reserved key`);
      out[key] = walk(child, depth + 1);
    }
    return out;
  }
  const result = walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) invalid(`${field} is too large`);
  return result;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const durableJson = value => JSON.parse(JSON.stringify(value));

function hashCommand(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function normalizeDetails(value) {
  if (value == null) return { schemaVersion: 1, data: {} };
  assertKeys(value, ['schemaVersion', 'mode', 'type', 'perSide', 'assistedKg', 'speedKph', 'distanceKm', 'drops', 'clusters', 'sides', 'status', 'tempo', 'restSeconds'], 'details must be a schema-versioned object');
  if (value.schemaVersion != null && value.schemaVersion !== 1) invalid('details.schemaVersion must be 1');
  const data = {};
  if (value.mode != null) {
    if (!['reps', 'time', 'cardio'].includes(value.mode)) invalid('details.mode is invalid');
    data.mode = value.mode;
  }
  if (value.type != null) {
    if (!['straight', 'dropset', 'restpause'].includes(value.type)) invalid('details.type is invalid');
    data.type = value.type;
  }
  if (value.perSide != null) {
    if (typeof value.perSide !== 'boolean') invalid('details.perSide must be a boolean');
    data.perSide = value.perSide;
  }
  if (value.assistedKg != null) data.assistedKg = decimal(value.assistedKg, 'details.assistedKg', 1000);
  if (value.speedKph != null) data.speedKph = decimal(value.speedKph, 'details.speedKph', 1000, 2);
  if (value.distanceKm != null) data.distanceKm = decimal(value.distanceKm, 'details.distanceKm', 10000, 3);
  if (value.restSeconds != null) data.restSeconds = integer(value.restSeconds, 'details.restSeconds', 0, 86400);
  if (value.status != null) data.status = boundedText(value.status, 'details.status', 24, false);
  if (value.tempo != null) data.tempo = boundedText(value.tempo, 'details.tempo', 40);
  if (value.drops != null) {
    if (!Array.isArray(value.drops) || value.drops.length > 20) invalid('details.drops must be an array of at most 20 items');
    data.drops = value.drops.map(drop => {
      assertKeys(drop, ['weightKg', 'reps'], 'a drop must contain weightKg and reps');
      return { weightKg: decimal(drop.weightKg, 'drop.weightKg', 2000), reps: integer(drop.reps, 'drop.reps', 0, 10000) };
    });
  }
  if (value.clusters != null) {
    if (!Array.isArray(value.clusters) || value.clusters.length > 20) invalid('details.clusters must be an array of at most 20 items');
    data.clusters = value.clusters.map(cluster => {
      assertKeys(cluster, ['reps', 'restSeconds'], 'a cluster must contain reps and restSeconds');
      return { reps: integer(cluster.reps, 'cluster.reps', 0, 10000), restSeconds: integer(cluster.restSeconds, 'cluster.restSeconds', 0, 86400) };
    });
  }
  if (value.sides != null) {
    assertKeys(value.sides, ['L', 'R'], 'details.sides must contain L and/or R');
    data.sides = {};
    for (const side of ['L', 'R']) if (value.sides[side] != null) {
      const row = value.sides[side];
      assertKeys(row, ['weightKg', 'reps', 'rir', 'rpe', 'done', 'drops', 'clusters'], `details.sides.${side} is invalid`);
      const out = {};
      if (row.weightKg != null) out.weightKg = decimal(row.weightKg, `details.sides.${side}.weightKg`, 2000);
      if (row.reps != null) out.reps = integer(row.reps, `details.sides.${side}.reps`, 0, 10000);
      if (row.rir != null) out.rir = decimal(row.rir, `details.sides.${side}.rir`, 10, 1);
      if (row.rpe != null) out.rpe = decimal(row.rpe, `details.sides.${side}.rpe`, 10, 1);
      if (row.rir != null && row.rpe != null) invalid(`details.sides.${side} cannot contain both RIR and RPE`);
      if (row.done != null) {
        if (typeof row.done !== 'boolean') invalid(`details.sides.${side}.done must be a boolean`);
        out.done = row.done;
      }
      if (row.drops != null) out.drops = normalizeDetails({ drops: row.drops }).data.drops;
      if (row.clusters != null) out.clusters = normalizeDetails({ clusters: row.clusters }).data.clusters;
      data.sides[side] = out;
    }
  }
  return { schemaVersion: 1, data: cleanJson(data, 'details', 8000) };
}

const SET_FIELDS = ['position', 'plannedSetSlotId', 'phase', 'weightKg', 'reps', 'durationSeconds', 'rir', 'rpe', 'done', 'notes', 'details'];
function normalizeSetFields(value, { create = false } = {}) {
  assertKeys(value, SET_FIELDS, 'set fields are invalid');
  const out = {};
  if (value.position != null) out.position = integer(value.position, 'position', 0, 500);
  else if (create) out.position = null;
  if (value.plannedSetSlotId != null) out.plannedSetSlotId = boundedText(value.plannedSetSlotId, 'plannedSetSlotId', 128, false);
  else if (create) out.plannedSetSlotId = null;
  if (value.phase != null) {
    if (!['WARMUP', 'WORK'].includes(value.phase)) invalid('phase must be WARMUP or WORK');
    out.phase = value.phase;
  } else if (create) out.phase = 'WORK';
  if ('weightKg' in value) out.weightKg = decimal(value.weightKg, 'weightKg', 2000);
  else if (create) out.weightKg = null;
  if ('reps' in value) out.reps = value.reps == null ? null : integer(value.reps, 'reps', 0, 10000);
  else if (create) out.reps = null;
  if ('durationSeconds' in value) out.durationSeconds = value.durationSeconds == null ? null : integer(value.durationSeconds, 'durationSeconds', 0, 1000000);
  else if (create) out.durationSeconds = null;
  if ('rir' in value) out.rir = decimal(value.rir, 'rir', 10, 1);
  else if (create) out.rir = null;
  if ('rpe' in value) out.rpe = decimal(value.rpe, 'rpe', 10, 1);
  else if (create) out.rpe = null;
  if (out.rir != null && out.rpe != null) invalid('a set cannot contain both RIR and RPE');
  if (value.done != null) {
    if (typeof value.done !== 'boolean') invalid('done must be a boolean');
    out.done = value.done;
  } else if (create) out.done = false;
  if ('notes' in value) out.notes = value.notes == null ? null : boundedText(value.notes, 'notes', 500);
  else if (create) out.notes = null;
  if ('details' in value) out.details = normalizeDetails(value.details);
  else if (create) out.details = { schemaVersion: 1, data: {} };
  return out;
}

const EXERCISE_FIELDS = ['exerciseId', 'name', 'routineSlotId', 'position', 'snapshot', 'prescription', 'notes', 'noProgression', 'sets'];
function normalizeExercise(value, { create = false } = {}) {
  assertKeys(value, EXERCISE_FIELDS, 'exercise is invalid');
  const exerciseId = boundedText(value.exerciseId, 'exerciseId', 128, false);
  const name = boundedText(value.name, 'name', 160, false);
  const snapshot = cleanJson(value.snapshot ?? { id: exerciseId, name }, 'exercise snapshot', 12000);
  if (!isObject(snapshot)) invalid('exercise snapshot must be an object');
  const out = { exerciseId, name, snapshot };
  if (value.routineSlotId != null) out.routineSlotId = boundedText(value.routineSlotId, 'routineSlotId', 128, false);
  else if (create) out.routineSlotId = null;
  if (value.position != null) out.position = integer(value.position, 'exercise position', 0, 500);
  else if (create) out.position = null;
  if (value.prescription != null) {
    if (!isObject(value.prescription)) invalid('prescription must be an object');
    out.prescription = cleanJson(value.prescription, 'prescription', 8000);
  }
  if (value.notes != null) out.notes = boundedText(value.notes, 'exercise notes', 500);
  else if (create) out.notes = null;
  if (value.noProgression != null) {
    if (typeof value.noProgression !== 'boolean') invalid('noProgression must be a boolean');
    out.noProgression = value.noProgression;
  } else if (create) out.noProgression = false;
  if (value.sets != null) {
    if (!Array.isArray(value.sets) || value.sets.length > 50) invalid('exercise sets must contain at most 50 rows');
    out.sets = value.sets.map((set, index) => {
      const row = normalizeSetFields(set, { create: true });
      row.position ??= index;
      return row;
    });
  } else if (create) out.sets = [];
  return out;
}

export function normalizeWorkoutRoutineSnapshot(value) {
  if (value == null) return { name: 'Freestyle', exercises: [] };
  assertKeys(value, ['id', 'name', 'routineIds', 'day', 'deload', 'deloadMetadata', 'program', 'readiness', 'notes', 'exercises'], 'routineSnapshot is invalid');
  const out = cleanJson(value, 'routineSnapshot', 128000);
  if (out.id != null) out.id = boundedText(out.id, 'routineSnapshot.id', 128, false);
  if (out.name != null) out.name = boundedText(out.name, 'routineSnapshot.name', 120);
  if (out.routineIds != null) {
    if (!Array.isArray(out.routineIds) || out.routineIds.length > 20) invalid('routineSnapshot.routineIds must contain at most 20 ids');
    out.routineIds = out.routineIds.map(id => boundedText(id, 'routineSnapshot.routineIds item', 128, false));
  }
  if (out.day != null) out.day = boundedText(out.day, 'routineSnapshot.day', 80);
  if (out.deload != null && typeof out.deload !== 'boolean') invalid('routineSnapshot.deload must be a boolean');
  for (const field of ['deloadMetadata', 'program', 'readiness']) {
    if (out[field] != null && !isObject(out[field])) invalid(`routineSnapshot.${field} must be an object`);
  }
  if (out.notes != null) out.notes = boundedText(out.notes, 'routineSnapshot.notes', 1000);
  if (!Array.isArray(out.exercises || [])) invalid('routineSnapshot.exercises must be an array');
  if ((out.exercises || []).length > 50) invalid('routineSnapshot can contain at most 50 exercises');
  let setCount = 0;
  out.exercises = (out.exercises || []).map((exercise, index) => {
    const normalized = normalizeExercise({ ...exercise, position: exercise.position ?? index }, { create: true });
    setCount += normalized.sets.length;
    return normalized;
  });
  if (setCount > 500) invalid('routineSnapshot can contain at most 500 sets');
  return out;
}

function parseStartBody(body) {
  assertKeys(body, ['organizationId', 'operationId', 'routineSnapshot']);
  return {
    organizationId: body.organizationId == null ? null : uuid(body.organizationId, 'organizationId'),
    operationId: uuid(body.operationId),
    routineSnapshot: normalizeWorkoutRoutineSnapshot(body.routineSnapshot)
  };
}

export function normalizeWorkoutOperation(body) {
  assertKeys(body, ['operationId', 'type', 'target', 'expectedSetVersion', 'expectedSessionVersion', 'patch']);
  const operationId = uuid(body.operationId);
  const types = ['set.create', 'set.update', 'set.delete', 'exercise.add', 'exercise.swap', 'exercise.reorder', 'exercise.remove', 'session.update'];
  if (!types.includes(body.type)) invalid('type is not supported');
  const target = body.target == null ? {} : body.target;
  assertKeys(target, ['setId', 'exerciseId'], 'target is invalid');
  const patch = body.patch == null ? {} : body.patch;
  assertObject(patch, 'patch is invalid');
  const command = { operationId, type: body.type, target: {}, patch: {} };
  if (target.setId != null) command.target.setId = uuid(target.setId, 'target.setId');
  if (target.exerciseId != null) command.target.exerciseId = uuid(target.exerciseId, 'target.exerciseId');
  if (body.expectedSetVersion != null) command.expectedSetVersion = integer(body.expectedSetVersion, 'expectedSetVersion', 1, 2147483647);
  if (body.expectedSessionVersion != null) command.expectedSessionVersion = integer(body.expectedSessionVersion, 'expectedSessionVersion', 1, 2147483647);

  if (body.type === 'set.create') {
    if (!onlyKeys(target, ['exerciseId'])) invalid('set.create target is invalid');
    if (!command.target.exerciseId) invalid('target.exerciseId is required');
    command.patch = normalizeSetFields(patch, { create: true });
  } else if (body.type === 'set.update') {
    if (!onlyKeys(target, ['setId'])) invalid('set.update target is invalid');
    if (!command.target.setId || !command.expectedSetVersion) invalid('target.setId and expectedSetVersion are required');
    command.patch = normalizeSetFields(patch);
    if (!Object.keys(command.patch).length) invalid('patch must contain a set field');
  } else if (body.type === 'set.delete') {
    if (!onlyKeys(target, ['setId'])) invalid('set.delete target is invalid');
    if (!command.target.setId || !command.expectedSetVersion || Object.keys(patch).length) invalid('set.delete requires target.setId and expectedSetVersion only');
  } else if (body.type === 'exercise.add') {
    if (Object.keys(target).length) invalid('exercise.add target must be empty');
    if (command.expectedSessionVersion == null) invalid('expectedSessionVersion is required');
    if (!onlyKeys(patch, ['exercise'])) invalid('exercise.add patch is invalid');
    command.patch.exercise = normalizeExercise(patch.exercise, { create: true });
  } else if (body.type === 'exercise.swap') {
    if (!onlyKeys(target, ['exerciseId'])) invalid('exercise.swap target is invalid');
    if (!command.target.exerciseId || command.expectedSessionVersion == null || !onlyKeys(patch, ['exercise'])) invalid('exercise.swap requires target.exerciseId, expectedSessionVersion, and patch.exercise');
    command.patch.exercise = normalizeExercise(patch.exercise, { create: true });
  } else if (body.type === 'exercise.reorder') {
    if (!onlyKeys(target, ['exerciseId'])) invalid('exercise.reorder target is invalid');
    if (!command.target.exerciseId || command.expectedSessionVersion == null || !onlyKeys(patch, ['position'])) invalid('exercise.reorder requires target.exerciseId, expectedSessionVersion, and patch.position');
    command.patch.position = integer(patch.position, 'position', 0, 500);
  } else if (body.type === 'exercise.remove') {
    if (!onlyKeys(target, ['exerciseId'])) invalid('exercise.remove target is invalid');
    if (!command.target.exerciseId || command.expectedSessionVersion == null || Object.keys(patch).length) invalid('exercise.remove requires target.exerciseId and expectedSessionVersion only');
  } else {
    if (Object.keys(target).length) invalid('session.update target must be empty');
    if (command.expectedSessionVersion == null || !onlyKeys(patch, ['notes'])) invalid('session.update requires expectedSessionVersion and patch.notes');
    command.patch.notes = patch.notes == null ? null : boundedText(patch.notes, 'notes', 1000);
  }
  const payload = { ...command };
  if (Buffer.byteLength(stableJson(payload)) > 32000) invalid('operation is too large');
  return command;
}

function normalizeLifecycleBody(body) {
  assertKeys(body, ['operationId', 'expectedSessionVersion']);
  return { operationId: uuid(body.operationId), expectedSessionVersion: integer(body.expectedSessionVersion, 'expectedSessionVersion', 1, 2147483647) };
}

function setData(fields, actorUserId, create = false) {
  const data = {};
  for (const field of ['position', 'plannedSetSlotId', 'phase', 'weightKg', 'reps', 'durationSeconds', 'rir', 'rpe', 'done', 'notes']) {
    if (field in fields) data[field] = fields[field];
  }
  if ('details' in fields) data.details = fields.details;
  if (create) {
    data.createdByUserId = actorUserId;
    data.updatedByUserId = actorUserId;
  } else data.updatedByUserId = actorUserId;
  return data;
}

function exerciseData(sessionId, fields) {
  return {
    sessionId, exerciseId: fields.exerciseId, name: fields.name,
    position: fields.position, snapshot: fields.snapshot,
    ...(fields.routineSlotId != null ? { routineSlotId: fields.routineSlotId } : {}),
    ...(fields.prescription != null ? { prescription: fields.prescription } : {}),
    ...(fields.notes != null ? { notes: fields.notes } : {}),
    noProgression: fields.noProgression
  };
}

async function createExerciseWithSets(tx, sessionId, fields, actorUserId) {
  const exercise = await tx.workoutSessionExercise.create({ data: exerciseData(sessionId, fields) });
  const sets = [];
  for (const set of fields.sets || []) {
    sets.push(await tx.workoutSet.create({ data: { ...setData(set, actorUserId, true), sessionExerciseId: exercise.id } }));
  }
  return { exercise, sets };
}

function serializeSet(set) {
  return {
    id: set.id, plannedSetSlotId: set.plannedSetSlotId,
    position: set.position, phase: set.phase,
    weightKg: set.weightKg == null ? null : String(set.weightKg), reps: set.reps,
    durationSeconds: set.durationSeconds,
    rir: set.rir == null ? null : String(set.rir), rpe: set.rpe == null ? null : String(set.rpe),
    done: set.done, notes: set.notes, details: set.details, version: set.version,
    deletedAt: set.deletedAt, createdAt: set.createdAt, updatedAt: set.updatedAt
  };
}

function serializeExercise(exercise) {
  return {
    id: exercise.id, exerciseId: exercise.exerciseId, name: exercise.name,
    routineSlotId: exercise.routineSlotId, position: exercise.position,
    snapshot: exercise.snapshot, prescription: exercise.prescription,
    notes: exercise.notes, noProgression: exercise.noProgression,
    version: exercise.version, deletedAt: exercise.deletedAt,
    sets: exercise.sets.map(serializeSet)
  };
}

async function loadSession(tx, sessionId) {
  return tx.workoutSession.findUnique({
    where: { id: sessionId },
    include: { exercises: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: { sets: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] } } } }
  });
}

function serializeSession(session, role, sequence = session.lastEventSeq) {
  return {
    id: session.id, clientUserId: session.clientUserId, organizationId: session.organizationId,
    startedByUserId: session.startedByUserId, viewerRole: role, status: session.status,
    startedAt: session.startedAt, completedAt: session.completedAt, cancelledAt: session.cancelledAt,
    updatedAt: session.updatedAt, version: session.version, lastEventSeq: seqString(sequence),
    routineSnapshot: session.routineSnapshot, completionSnapshot: session.completionSnapshot,
    notes: session.notes, source: session.source, metadata: session.metadata,
    exercises: session.exercises.map(serializeExercise)
  };
}

async function sessionResponse(tx, sessionId, role, sequence) {
  const session = await loadSession(tx, sessionId);
  return serializeSession(session, role, sequence);
}

async function lockSession(tx, sessionId) {
  const rows = await tx.$queryRawUnsafe(SESSION_LOCK, sessionId);
  if (!rows.length) notFound();
  return tx.workoutSession.findUnique({ where: { id: sessionId } });
}

async function lockClient(tx, clientUserId) {
  const rows = await tx.$queryRawUnsafe(USER_LOCK, clientUserId);
  if (!rows.length) notFound();
}

async function lockOwnedSession(tx, sessionId) {
  const owner = await tx.workoutSession.findUnique({ where: { id: sessionId }, select: { clientUserId: true } });
  if (!owner) notFound();
  await lockClient(tx, owner.clientUserId);
  return lockSession(tx, sessionId);
}

async function authorizeScope(tx, actorUserId, session, scope) {
  if (session.clientUserId === actorUserId) return 'CLIENT';
  if (!session.organizationId) notFound();
  const grants = await tx.$queryRawUnsafe(GRANT_LOCK,
    actorUserId, session.clientUserId, session.organizationId, scope);
  if (!grants.length) notFound();
  return 'TRAINER';
}

async function authorizeClientStart(tx, actorUserId, clientUserId, organizationId) {
  if (actorUserId === clientUserId) {
    if (organizationId) {
      const enrollment = await tx.$queryRawUnsafe(`SELECT e.id FROM ClientOrganizationEnrollment AS e
        JOIN Organization AS o ON o.id = e.organizationId JOIN User AS c ON c.id = e.clientUserId
        WHERE e.clientUserId = ? AND e.organizationId = ? AND e.status = 'ACTIVE'
          AND o.status = 'ACTIVE' AND c.status = 'ACTIVE' FOR UPDATE`, clientUserId, organizationId);
      if (!enrollment.length) notFound();
    }
    return 'CLIENT';
  }
  if (!organizationId) notFound();
  await authorizeScope(tx, actorUserId, { clientUserId, organizationId }, 'START_SESSION');
  return 'TRAINER';
}

async function operationFor(tx, sessionId, operationId) {
  return tx.workoutOperation.findUnique({ where: { sessionId_operationId: { sessionId, operationId } } });
}

function replayed(operation, requestHash) {
  if (operation.requestHash !== requestHash) conflict('operationId was already used for a different command', 'IDEMPOTENCY_KEY_REUSED');
  return operation.result;
}

async function commitOperation(tx, { session, actorUserId, operationId, type, requestHash, response, eventType, eventPayload }) {
  const sequence = BigInt(session.lastEventSeq) + 1n;
  await tx.workoutSession.update({ where: { id: session.id }, data: { lastEventSeq: sequence } });
  const result = durableJson(response);
  const operation = await tx.workoutOperation.create({
    data: { sessionId: session.id, operationId, actorUserId, type, requestHash, result }
  });
  await tx.workoutEvent.create({
    data: {
      sessionId: session.id, sequence, operationId, actorUserId,
      type: eventType, payload: cleanJson(durableJson(eventPayload), 'event payload', 32000, 12)
    }
  });
  return { response: result, sequence, operation };
}

function isRetryable(error) {
  return ['P2034', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', '1213', '1205'].includes(String(error?.code))
    || /deadlock found|lock wait timeout/i.test(error?.message || '');
}

async function transaction(db, run) {
  for (let attempt = 0; ; attempt++) {
    try {
      // The owner pre-read must not pin a repeatable-read snapshot before the client/session locks.
      return await db.$transaction(run, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 15000 });
    }
    catch (error) {
      if (attempt >= 2 || !isRetryable(error)) throw error;
    }
  }
}

export async function startWorkoutSession(db, { actorUserId, clientUserId, body }) {
  const input = parseStartBody(body);
  const requestHash = hashCommand({ action: 'session.start', actorUserId, clientUserId, ...input });
  return transaction(db, async tx => {
    const locked = await tx.$queryRawUnsafe(USER_LOCK, clientUserId);
    if (!locked.length) notFound();
    const role = await authorizeClientStart(tx, actorUserId, clientUserId, input.organizationId);

    const prior = await tx.workoutOperation.findFirst({
      where: { actorUserId, operationId: input.operationId },
      include: { session: true }
    });
    if (prior) {
      if (prior.type !== 'session.start') conflict('operationId was already used for a different command', 'IDEMPOTENCY_KEY_REUSED');
      if (prior.session.clientUserId !== clientUserId || prior.session.organizationId !== input.organizationId) {
        conflict('operationId was already used for a different command', 'IDEMPOTENCY_KEY_REUSED');
      }
      await authorizeScope(tx, actorUserId, prior.session, 'START_SESSION');
      return { statusCode: 200, body: replayed(prior, requestHash) };
    }

    const active = await tx.clientActiveSession.findUnique({
      where: { clientUserId }, include: { session: true }
    });
    if (active) {
      const activeSession = await lockSession(tx, active.session.id);
      if (activeSession.clientUserId !== clientUserId || activeSession.status !== 'ACTIVE') fail(503, 'active session slot is inconsistent', 'SESSION_SLOT_INCONSISTENT');
      const viewerRole = await authorizeScope(tx, actorUserId, activeSession, 'VIEW_TRAINING');
      const priorOnSession = await operationFor(tx, activeSession.id, input.operationId);
      if (priorOnSession) return { statusCode: 200, body: replayed(priorOnSession, requestHash) };
      const seq = BigInt(activeSession.lastEventSeq) + 1n;
      const snapshot = await sessionResponse(tx, activeSession.id, viewerRole, seq);
      const response = { alreadyActive: true, session: snapshot };
      const committed = await commitOperation(tx, {
        session: activeSession, actorUserId, operationId: input.operationId,
        type: 'session.start', requestHash, response,
        eventType: 'session.joined', eventPayload: { sessionId: activeSession.id, actorUserId }
      });
      return { statusCode: 200, body: committed.response };
    }

    const sessionId = randomUUID();
    const session = await tx.workoutSession.create({ data: {
      id: sessionId, clientUserId, organizationId: input.organizationId,
      startedByUserId: actorUserId, status: 'ACTIVE', version: 1,
      routineSnapshot: input.routineSnapshot,
      source: input.routineSnapshot.exercises.length ? 'snapshot' : 'freestyle'
    } });
    for (const exercise of input.routineSnapshot.exercises) await createExerciseWithSets(tx, session.id, exercise, actorUserId);
    await tx.clientActiveSession.create({ data: { clientUserId, sessionId } });
    const sequence = BigInt(session.lastEventSeq) + 1n;
    await tx.workoutSession.update({ where: { id: sessionId }, data: { lastEventSeq: sequence } });
    const fullSnapshot = await sessionResponse(tx, sessionId, 'CLIENT', sequence);
    const snapshot = role === 'CLIENT'
      ? fullSnapshot
      : { id: sessionId, status: 'ACTIVE', version: 1, lastEventSeq: seqString(sequence) };
    const response = durableJson({ alreadyActive: false, session: snapshot });
    await tx.workoutOperation.create({
      data: { sessionId, operationId: input.operationId, actorUserId, type: 'session.start', requestHash, result: response }
    });
    await tx.workoutEvent.create({
      data: {
        sessionId, sequence, operationId: input.operationId, actorUserId,
        type: 'session.started',
        payload: cleanJson({
          clientUserId, organizationId: input.organizationId, routineSnapshot: input.routineSnapshot,
          exerciseIds: fullSnapshot.exercises.map(exercise => ({
            id: exercise.id, exerciseId: exercise.exerciseId,
            setIds: exercise.sets.map(set => set.id)
          }))
        }, 'event payload', 256000, 12)
      }
    });
    return { statusCode: 201, body: response };
  });
}

export async function getActiveWorkoutSession(db, { actorUserId, clientUserId }) {
  if (actorUserId !== clientUserId) notFound();
  return transaction(db, async tx => {
    await lockClient(tx, clientUserId);
    const active = await tx.clientActiveSession.findUnique({ where: { clientUserId }, select: { sessionId: true } });
    if (!active) return { session: null };
    const session = await lockSession(tx, active.sessionId);
    if (session.clientUserId !== clientUserId || session.status !== 'ACTIVE') {
      fail(503, 'active session slot is inconsistent', 'SESSION_SLOT_INCONSISTENT');
    }
    return { session: serializeSession(await loadSession(tx, active.sessionId), 'CLIENT') };
  });
}

export async function getWorkoutSession(db, { actorUserId, sessionId }) {
  return transaction(db, async tx => {
    const session = await lockOwnedSession(tx, sessionId);
    const role = await authorizeScope(tx, actorUserId, session, 'VIEW_TRAINING');
    const full = await loadSession(tx, sessionId);
    return { session: serializeSession(full, role) };
  });
}

export async function getWorkoutEvents(db, { actorUserId, sessionId, afterSequence, limit = 100 }) {
  return transaction(db, async tx => {
    const session = await lockOwnedSession(tx, sessionId);
    await authorizeScope(tx, actorUserId, session, 'VIEW_TRAINING');
    const rows = await tx.workoutEvent.findMany({
      where: { sessionId, sequence: { gt: BigInt(afterSequence) } },
      orderBy: { sequence: 'asc' }, take: limit + 1
    });
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(event => ({ ...event, sequence: seqString(event.sequence) }));
    return {
      events, hasMore,
      nextSequence: events.length ? events[events.length - 1].sequence : String(afterSequence),
      lastEventSeq: seqString(session.lastEventSeq)
    };
  });
}

function conflictDetails(entity, current, expectedVersion, sequence) {
  return {
    entity, entityId: current.id,
    expectedVersion, currentVersion: current.version,
    current: entity === 'workoutSet' ? serializeSet(current) : { id: current.id, version: current.version, status: current.status },
    latestSessionSequence: seqString(sequence)
  };
}

async function updateExercisePosition(tx, sessionId, targetId, position) {
  const exercises = await tx.workoutSessionExercise.findMany({
    where: { sessionId, deletedAt: null }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }]
  });
  const currentIndex = exercises.findIndex(exercise => exercise.id === targetId);
  if (currentIndex < 0) notFound();
  const [target] = exercises.splice(currentIndex, 1);
  const index = Math.min(position, exercises.length);
  exercises.splice(index, 0, target);
  for (let i = 0; i < exercises.length; i++) {
    const row = exercises[i];
    if (row.position !== i) await tx.workoutSessionExercise.update({
      where: { id: row.id }, data: { position: i, version: { increment: 1 } }
    });
  }
  return { exerciseId: targetId, position: index };
}

async function applyOperation(tx, session, actorUserId, command) {
  const { type, target, patch } = command;
  if (type === 'set.create') {
    const exercise = await tx.workoutSessionExercise.findFirst({
      where: { id: target.exerciseId, sessionId: session.id, deletedAt: null }, select: { id: true }
    });
    if (!exercise) notFound();
    if (patch.plannedSetSlotId != null) {
      const existing = await tx.workoutSet.findFirst({ where: { sessionExerciseId: exercise.id, plannedSetSlotId: patch.plannedSetSlotId } });
      if (existing) conflict('planned set slot already exists', 'PLANNED_SET_EXISTS', { current: serializeSet(existing) });
    }
    const currentPosition = await tx.workoutSet.count({ where: { sessionExerciseId: exercise.id, deletedAt: null } });
    const data = setData({ ...patch, position: patch.position ?? currentPosition }, actorUserId, true);
    let set;
    try { set = await tx.workoutSet.create({ data: { ...data, sessionExerciseId: exercise.id } }); }
    catch (error) {
      if (error?.code !== 'P2002' || patch.plannedSetSlotId == null) throw error;
      const current = await tx.workoutSet.findFirst({ where: { sessionExerciseId: exercise.id, plannedSetSlotId: patch.plannedSetSlotId } });
      conflict('planned set slot already exists', 'PLANNED_SET_EXISTS', current ? { current: serializeSet(current) } : {});
    }
    return { type, set: serializeSet(set) };
  }
  if (type === 'set.update' || type === 'set.delete') {
    const current = await tx.workoutSet.findFirst({
      where: { id: target.setId, sessionExercise: { sessionId: session.id } }
    });
    if (!current) notFound();
    if (current.version !== command.expectedSetVersion || current.deletedAt) {
      conflict('workout set changed since it was read', 'VERSION_CONFLICT', conflictDetails('workoutSet', current, command.expectedSetVersion, session.lastEventSeq));
    }
    const where = { id: current.id, version: command.expectedSetVersion, deletedAt: null };
    const data = type === 'set.delete'
      ? { deletedAt: new Date(), updatedByUserId: actorUserId, version: { increment: 1 } }
      : { ...setData(patch, actorUserId), version: { increment: 1 } };
    const changed = await tx.workoutSet.updateMany({ where, data });
    if (changed.count !== 1) {
      const latest = await tx.workoutSet.findUnique({ where: { id: current.id } });
      conflict('workout set changed since it was read', 'VERSION_CONFLICT', conflictDetails('workoutSet', latest, command.expectedSetVersion, session.lastEventSeq));
    }
    return { type, set: serializeSet(await tx.workoutSet.findUnique({ where: { id: current.id } })) };
  }
  if (type === 'session.update') {
    await tx.workoutSession.update({ where: { id: session.id }, data: { notes: patch.notes, version: { increment: 1 } } });
    return { type, notes: patch.notes };
  }

  let current;
  if (type !== 'exercise.add') {
    current = await tx.workoutSessionExercise.findFirst({
      where: { id: target.exerciseId, sessionId: session.id, deletedAt: null }, include: { sets: true }
    });
    if (!current) notFound();
  }
  if (type === 'exercise.add') {
    const count = await tx.workoutSessionExercise.count({ where: { sessionId: session.id, deletedAt: null } });
    const fields = { ...patch.exercise, position: patch.exercise.position ?? count };
    const created = await createExerciseWithSets(tx, session.id, fields, actorUserId);
    await tx.workoutSession.update({ where: { id: session.id }, data: { version: { increment: 1 } } });
    return { type, exercise: serializeExercise({ ...created.exercise, sets: created.sets }) };
  }
  if (type === 'exercise.swap') {
    const now = new Date();
    await tx.workoutSessionExercise.update({ where: { id: current.id }, data: { deletedAt: now, routineSlotId: null, version: { increment: 1 } } });
    await tx.workoutSet.updateMany({ where: { sessionExerciseId: current.id, deletedAt: null }, data: { deletedAt: now, version: { increment: 1 } } });
    const fields = {
      ...patch.exercise,
      routineSlotId: patch.exercise.routineSlotId ?? current.routineSlotId,
      position: current.position,
      sets: patch.exercise.sets || []
    };
    const created = await createExerciseWithSets(tx, session.id, fields, actorUserId);
    await tx.workoutSession.update({ where: { id: session.id }, data: { version: { increment: 1 } } });
    return { type, replacedExerciseId: current.id, exercise: serializeExercise({ ...created.exercise, sets: created.sets }) };
  }
  if (type === 'exercise.remove') {
    const now = new Date();
    await tx.workoutSessionExercise.update({ where: { id: current.id }, data: { deletedAt: now, routineSlotId: null, version: { increment: 1 } } });
    const tombstoned = await tx.workoutSet.updateMany({
      where: { sessionExerciseId: current.id, deletedAt: null }, data: { deletedAt: now, version: { increment: 1 } }
    });
    await tx.workoutSession.update({ where: { id: session.id }, data: { version: { increment: 1 } } });
    return { type, exerciseId: current.id, tombstonedSets: tombstoned.count };
  }
  const result = await updateExercisePosition(tx, session.id, current.id, patch.position);
  await tx.workoutSession.update({ where: { id: session.id }, data: { version: { increment: 1 } } });
  return { type, ...result };
}

export async function applyWorkoutOperation(db, { actorUserId, sessionId, body }) {
  const command = normalizeWorkoutOperation(body);
  const requestHash = hashCommand({ actorUserId, sessionId, ...command });
  return transaction(db, async tx => {
    const session = await lockOwnedSession(tx, sessionId);
    await authorizeScope(tx, actorUserId, session, 'LOG_SETS');
    const prior = await operationFor(tx, sessionId, command.operationId);
    if (prior) return replayed(prior, requestHash);
    if (session.status !== 'ACTIVE') conflict('workout session is finalized', 'SESSION_FINALIZED', { status: session.status });
    const structural = command.type.startsWith('exercise.') || command.type === 'session.update';
    if (structural && session.version !== command.expectedSessionVersion) {
      conflict('workout structure changed since it was read', 'VERSION_CONFLICT', {
        entity: 'workoutSession', entityId: session.id, expectedVersion: command.expectedSessionVersion,
        currentVersion: session.version, current: { id: session.id, version: session.version, status: session.status },
        latestSessionSequence: seqString(session.lastEventSeq)
      });
    }
    const effect = await applyOperation(tx, session, actorUserId, command);
    const sequence = BigInt(session.lastEventSeq) + 1n;
    await tx.workoutSession.update({ where: { id: sessionId }, data: { lastEventSeq: sequence } });
    const current = await tx.workoutSession.findUnique({ where: { id: sessionId }, select: { version: true } });
    const response = durableJson({ operationId: command.operationId, result: effect, sessionId, version: current.version, lastEventSeq: seqString(sequence) });
    await tx.workoutOperation.create({
      data: { sessionId, operationId: command.operationId, actorUserId, type: command.type, requestHash, result: response }
    });
    await tx.workoutEvent.create({
      data: {
        sessionId, sequence, operationId: command.operationId, actorUserId,
        type: command.type, payload: cleanJson(durableJson({ command, result: effect }), 'event payload', 64000, 12)
      }
    });
    return response;
  });
}

function completedProjection(session, endedAt) {
  const hasCompleted = set => set.done === true || set.details?.data?.sides?.L?.done === true || set.details?.data?.sides?.R?.done === true;
  const exercises = session.exercises.filter(exercise => exercise.deletedAt == null)
    .map(exercise => ({ ...serializeExercise(exercise), sets: exercise.sets.filter(set => set.deletedAt == null).map(serializeSet) }))
    .filter(exercise => exercise.sets.some(hasCompleted));
  return {
    id: session.id, clientUserId: session.clientUserId, organizationId: session.organizationId,
    startedAt: session.startedAt, endedAt, routineSnapshot: session.routineSnapshot,
    notes: session.notes, exercises
  };
}

export async function finalizeWorkoutSession(db, { actorUserId, sessionId, body, status }) {
  const input = normalizeLifecycleBody(body);
  const requestHash = hashCommand({ actorUserId, sessionId, status, ...input });
  return transaction(db, async tx => {
    const session = await lockOwnedSession(tx, sessionId);
    await authorizeScope(tx, actorUserId, session, 'LOG_SETS');
    const prior = await operationFor(tx, sessionId, input.operationId);
    if (prior) return replayed(prior, requestHash);
    if (session.status !== 'ACTIVE') conflict('workout session is finalized', 'SESSION_FINALIZED', { status: session.status });
    if (session.version !== input.expectedSessionVersion) {
      conflict('workout structure changed since it was read', 'VERSION_CONFLICT', {
        entity: 'workoutSession', entityId: session.id, expectedVersion: input.expectedSessionVersion,
        currentVersion: session.version, current: { id: session.id, version: session.version, status: session.status },
        latestSessionSequence: seqString(session.lastEventSeq)
      });
    }
    const now = new Date();
    const full = await loadSession(tx, sessionId);
    const completion = status === 'COMPLETED' ? completedProjection(full, now) : null;
    await tx.workoutSession.update({ where: { id: sessionId }, data: {
      status, version: { increment: 1 },
      ...(status === 'COMPLETED' ? { completedAt: now, completionSnapshot: completion } : { cancelledAt: now })
    } });
    const released = await tx.clientActiveSession.deleteMany({ where: { clientUserId: session.clientUserId, sessionId } });
    if (released.count !== 1) fail(503, 'active session slot is inconsistent', 'SESSION_SLOT_INCONSISTENT');
    const sequence = BigInt(session.lastEventSeq) + 1n;
    await tx.workoutSession.update({ where: { id: sessionId }, data: { lastEventSeq: sequence } });
    const current = await tx.workoutSession.findUnique({ where: { id: sessionId } });
    const response = durableJson({
      operationId: input.operationId, sessionId, status: current.status,
      version: current.version, lastEventSeq: seqString(sequence),
      completedAt: current.completedAt, cancelledAt: current.cancelledAt
    });
    await tx.workoutOperation.create({
      data: { sessionId, operationId: input.operationId, actorUserId, type: `session.${status.toLowerCase()}`, requestHash, result: response }
    });
    await tx.workoutEvent.create({
      data: {
        sessionId, sequence, operationId: input.operationId, actorUserId,
        type: `session.${status.toLowerCase()}`,
        payload: cleanJson({
          status, completedExerciseCount: completion?.exercises.length || 0,
          completedSetCount: completion?.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0) || 0
        }, 'event payload', 1000)
      }
    });
    return response;
  });
}

export function validateEventCursor(value) {
  if (value == null || value === '') return '0';
  if (!/^(0|[1-9]\d{0,18})$/.test(String(value))) invalid('afterSequence must be a non-negative integer');
  const result = BigInt(value);
  if (result > 9223372036854775806n) invalid('afterSequence is too large');
  return result.toString();
}

export function parseEventLimit(value) {
  if (value == null || value === '') return 100;
  if (!/^\d{1,3}$/.test(String(value))) invalid('limit must be an integer between 1 and 100');
  const limit = Number(value);
  if (limit < 1 || limit > 100) invalid('limit must be an integer between 1 and 100');
  return limit;
}
