/** Database-free regression checks for the Home 0/1 training catalogue. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  importTrainingCatalogue,
  type CatalogueImportStore,
  type StoredRelease,
} from '../src/training/catalogue-import.js';
import {
  assertPublishable,
  canPerformExercise,
  canPerformWorkout,
  catalogueHash,
  exerciseContentHash,
  exerciseUsesEquipment,
  publicationBlockers,
  reviewedContentHash,
  validateTrainingCatalogue,
  workoutContentHash,
} from '../src/training/catalogue-policy.js';
import type {
  TrainingCatalogue,
  TrainingExercise,
  TrainingMedia,
  TrainingReview,
  TrainingWorkout,
  WorkoutPrescription,
} from '../src/training/catalogue.schema.js';

let passed = 0;
let failed = 0;

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}

const approval = (): TrainingReview => ({
  status: 'approved',
  reviewer: 'SELF-CHECK FIXTURE ONLY',
  reviewedAt: '2026-11-07T00:00:00.000Z',
  evidence: 'Synthetic approval used only by this database-free test.',
  approvedContentHash: 'a'.repeat(64),
});

function copy<T>(value: T): T {
  return structuredClone(value);
}

function expectRejected(catalogue: unknown, message: RegExp): void {
  assert.throws(() => validateTrainingCatalogue(catalogue), message);
}

function exercise(catalogue: TrainingCatalogue, id = 'push_up'): TrainingExercise {
  const found = catalogue.exercises.find((item) => item.id === id);
  assert.ok(found, `Starter fixture needs exercise ${id}`);
  return found;
}

function syntheticWorkout(item: TrainingExercise): TrainingWorkout {
  const prescription: WorkoutPrescription = {
    id: 'fixture_item',
    exerciseId: item.id,
    exerciseVersion: item.version,
    sets: 3,
    perSide: item.unilateral,
    restSec: 60,
  };
  if (item.measurementType === 'duration') prescription.durationSec = 20;
  else if (item.measurementType === 'distance') prescription.distanceM = 50;
  else prescription.reps = 8;
  if (item.measurementType === 'reps_load') {
    if (item.loadingMode === 'added_load') prescription.loadKg = 10;
    else prescription.assistanceKg = 10;
  }
  return {
    id: 'selfcheck_workout',
    version: 1,
    name: 'Self-check workout only',
    difficulty: item.difficulty,
    trainingType: item.trainingType,
    estimatedDurationMin: 15,
    sourceId: item.sourceId,
    review: {
      status: 'pending', reviewer: null, reviewedAt: null,
      evidence: null, approvedContentHash: null,
    },
    blocks: [{ id: 'fixture_main', type: 'main', rounds: 1, items: [prescription] }],
  };
}

function addWorkout(catalogue: TrainingCatalogue, id = 'push_up'): WorkoutPrescription {
  const workout = syntheticWorkout(exercise(catalogue, id));
  catalogue.workouts = [workout];
  return workout.blocks[0]!.items[0]!;
}

function approveForTest(catalogue: TrainingCatalogue): TrainingCatalogue {
  const approved = copy(catalogue);
  for (const source of approved.sources) {
    source.rights = { ...approval(), approvedContentHash: reviewedContentHash(source) };
  }
  for (const item of approved.exercises) {
    item.review = { ...approval(), approvedContentHash: exerciseContentHash(item) };
  }
  for (const workout of approved.workouts) {
    workout.review = { ...approval(), approvedContentHash: workoutContentHash(workout) };
  }
  for (const asset of approved.media) {
    asset.rights = { ...approval(), approvedContentHash: reviewedContentHash(asset) };
  }
  return approved;
}

function addMedia(catalogue: TrainingCatalogue): TrainingMedia {
  const item = exercise(catalogue);
  const media: TrainingMedia = {
    id: 'selfcheck_demo',
    type: 'video',
    url: 'https://example.test/selfcheck-demo.mp4',
    sourceId: item.sourceId,
    attribution: null,
    status: 'available',
    rights: approval(),
  };
  media.rights = { ...approval(), approvedContentHash: reviewedContentHash(media) };
  catalogue.media.push(media);
  item.mediaIds.push(media.id);
  if (item.review.status === 'approved') {
    item.review = { ...approval(), approvedContentHash: exerciseContentHash(item) };
  }
  return media;
}

/** In-memory import boundary: no MongoDB, environment access or file writes. */
class RecordingImportStore implements CatalogueImportStore {
  readonly calls: string[] = [];
  stored: StoredRelease | null = null;
  failure: 'writeRows' | 'complete' | 'activate' | null = null;

  async begin(catalogue: TrainingCatalogue, hash: string): Promise<StoredRelease> {
    this.calls.push('begin');
    this.stored ??= { releaseId: catalogue.releaseId, hash, status: 'writing' };
    return copy(this.stored);
  }

  async writeRows(_catalogue: TrainingCatalogue): Promise<void> {
    this.calls.push('writeRows');
    if (this.failure === 'writeRows') throw new Error('Fixture row write failure');
  }

  async complete(releaseId: string, hash: string, publish: boolean): Promise<void> {
    this.calls.push(`complete:${publish}`);
    if (this.failure === 'complete') throw new Error('Fixture completion failure');
    this.stored = { releaseId, hash, status: publish ? 'published' : 'staged' };
  }

  async activate(_catalogue: TrainingCatalogue, _hash: string): Promise<void> {
    this.calls.push('activate');
    if (this.failure === 'activate') throw new Error('Fixture activation failure');
  }
}

async function main(): Promise<void> {
  console.log('\nHome training catalogue pipeline\n');
  const raw: unknown = JSON.parse(await readFile(
    new URL('../data/training/starter-catalogue.json', import.meta.url),
    'utf8',
  ));
  const base = validateTrainingCatalogue(raw);

  await check('starter catalogue validates with stable unique muscle coverage', () => {
    assert.ok(base.exercises.length > 0);
    for (const muscle of base.muscles) {
      assert.ok(base.exercises.some((item) => item.primaryMuscleIds.includes(muscle.id)),
        `No primary exercise covers ${muscle.id}`);
    }
    assert.deepEqual(validateTrainingCatalogue(raw), base);
  });

  await check('starter drafts contain no fabricated editorial or source approvals', () => {
    assert.ok(base.sources.every((source) => source.rights.status === 'pending'));
    assert.ok(base.exercises.every((item) => item.review.status === 'pending'));
    assert.ok(base.workouts.every((item) => item.review.status === 'pending'));
    assert.ok(publicationBlockers(base).length > 0);
    assert.throws(() => assertPublishable(base), /not approved/);
  });

  await check('unknown schema versions fail before import', () => {
    expectRejected({ ...copy(base), schemaVersion: 2 }, /schemaVersion/);
  });
  await check('unknown exercise fields are rejected instead of silently stripped', () => {
    const draft = copy(base);
    Object.assign(exercise(draft), { hiddenProviderKey: 'fixture' });
    expectRejected(draft, /Unrecognized key|unrecognized/i);
  });

  for (const key of ['sources', 'muscles', 'equipment', 'media', 'exercises', 'workouts'] as const) {
    await check(`duplicate ${key} identities reject the whole bundle`, () => {
      const draft = copy(base);
      if (key === 'media') addMedia(draft);
      if (key === 'workouts') addWorkout(draft);
      const collection = draft[key] as Array<{ id: string }>;
      assert.ok(collection[0]);
      collection.push(copy(collection[0]));
      expectRejected(draft, new RegExp(`${key}: duplicate`));
    });
  }

  for (const key of ['primaryMuscleIds', 'secondaryMuscleIds', 'optionalEquipmentIds', 'mediaIds', 'regressionIds', 'progressionIds', 'substitutionIds'] as const) {
    await check(`dangling ${key} references reject the whole bundle`, () => {
      const draft = copy(base);
      exercise(draft)[key].push('missing_fixture_id');
      expectRejected(draft, new RegExp(`${key}: unknown reference`));
    });
  }
  await check('exercise, media and workout sources must all resolve', () => {
    const draft = copy(base);
    addMedia(draft).sourceId = 'missing_fixture_source';
    addWorkout(draft);
    draft.workouts[0]!.sourceId = 'missing_fixture_source';
    exercise(draft).sourceId = 'missing_fixture_source';
    expectRejected(draft, /sourceId: unknown reference/);
  });
  await check('primary and secondary roles cannot overlap for one exercise', () => {
    const draft = copy(base);
    const item = exercise(draft);
    item.secondaryMuscleIds.push(item.primaryMuscleIds[0]!);
    expectRejected(draft, /primary and secondary muscles overlap/);
  });
  await check('duplicate primary roles cannot multiply future set counts', () => {
    const draft = copy(base);
    const item = exercise(draft);
    item.primaryMuscleIds.push(item.primaryMuscleIds[0]!);
    expectRejected(draft, /primaryMuscleIds: duplicate/);
  });
  await check('aliases are unique after case normalization', () => {
    const draft = copy(base);
    exercise(draft).aliases = ['Fixture alias', 'fixture ALIAS'];
    expectRejected(draft, /aliases: duplicate/);
  });
  await check('one anatomy region cannot map to two distinct muscles', () => {
    const draft = copy(base);
    draft.muscles[0]!.svgRegionIds = ['fixture_region'];
    draft.muscles[1]!.svgRegionIds = ['fixture_region'];
    expectRejected(draft, /muscles.svgRegionIds: duplicate/);
  });

  await check('known no-equipment exercise matches an explicitly empty set', () => {
    const item = copy(exercise(base));
    item.equipmentStatus = 'known';
    item.equipmentRequirementGroups = [];
    item.optionalEquipmentIds = ['exercise_mat'];
    assert.equal(canPerformExercise(item, new Set()), true);
  });
  await check('unknown equipment never masquerades as no equipment', () => {
    const draft = copy(base);
    const item = exercise(draft);
    item.equipmentStatus = 'unknown';
    item.equipmentRequirementGroups = [];
    validateTrainingCatalogue(draft);
    assert.equal(canPerformExercise(item, new Set()), false);
    assert.equal(canPerformExercise(item, new Set(base.equipment.map((kit) => kit.id))), false);
  });
  await check('unknown equipment cannot simultaneously declare known required groups', () => {
    const draft = copy(base);
    exercise(draft).equipmentStatus = 'unknown';
    exercise(draft).equipmentRequirementGroups = [{ anyOf: ['pull_up_bar'] }];
    expectRejected(draft, /Unknown equipment cannot declare known requirements/);
  });
  await check('empty anyOf is invalid rather than no equipment', () => {
    const draft = copy(base);
    exercise(draft).equipmentRequirementGroups = [{ anyOf: [] }];
    expectRejected(draft, /equipmentRequirementGroups/);
  });
  await check('all mandatory equipment groups must match while each group permits alternatives', () => {
    const item = copy(exercise(base));
    item.equipmentStatus = 'known';
    item.equipmentRequirementGroups = [
      { anyOf: ['dumbbell_pair'] },
      { anyOf: ['flat_bench', 'adjustable_bench'] },
    ];
    assert.equal(canPerformExercise(item, new Set(['dumbbell_pair'])), false);
    assert.equal(canPerformExercise(item, new Set(['flat_bench'])), false);
    assert.equal(canPerformExercise(item, new Set(['dumbbell_pair', 'flat_bench'])), true);
    assert.equal(canPerformExercise(item, new Set(['dumbbell_pair', 'adjustable_bench'])), true);
  });
  await check('uses-equipment discovery includes optional kit without requiring it', () => {
    const item = copy(exercise(base));
    item.equipmentStatus = 'known';
    item.equipmentRequirementGroups = [{ anyOf: ['pull_up_bar', 'low_row_bar'] }];
    item.optionalEquipmentIds = ['exercise_mat'];
    assert.equal(exerciseUsesEquipment(item, 'pull_up_bar'), true);
    assert.equal(exerciseUsesEquipment(item, 'low_row_bar'), true);
    assert.equal(exerciseUsesEquipment(item, 'exercise_mat'), true);
    assert.equal(exerciseUsesEquipment(item, 'dumbbell'), false);
    assert.equal(canPerformExercise(item, new Set(['pull_up_bar'])), true);
  });
  await check('unknown and duplicate equipment alternatives are rejected', () => {
    const draft = copy(base);
    exercise(draft).equipmentRequirementGroups = [{ anyOf: ['missing_fixture_kit'] }];
    expectRejected(draft, /equipmentRequirementGroups: unknown reference/);
    exercise(draft).equipmentRequirementGroups = [{ anyOf: ['pull_up_bar', 'pull_up_bar'] }];
    expectRejected(draft, /equipmentRequirementGroups: duplicate/);
  });
  await check('equivalent requirement groups cannot be duplicated by reversing alternatives', () => {
    const draft = copy(base);
    exercise(draft).equipmentRequirementGroups = [
      { anyOf: ['flat_bench', 'adjustable_bench'] },
      { anyOf: ['adjustable_bench', 'flat_bench'] },
    ];
    expectRejected(draft, /equipmentRequirementGroups: duplicate/);
  });
  await check('equipment cannot be both optional and required', () => {
    const draft = copy(base);
    exercise(draft).equipmentRequirementGroups = [{ anyOf: ['pull_up_bar'] }];
    exercise(draft).optionalEquipmentIds = ['pull_up_bar'];
    expectRejected(draft, /both optional and required/);
  });

  await check('self-linked progression and unrelated variation parents reject import', () => {
    const draft = copy(base);
    exercise(draft).progressionIds = ['push_up'];
    expectRejected(draft, /self-reference/);
    exercise(draft).progressionIds = [];
    exercise(draft).variationOfId = 'pull_up';
    expectRejected(draft, /same family/);
  });
  for (const relationship of ['variationOfId', 'regressionIds', 'progressionIds'] as const) {
    await check(`${relationship} cycles reject the whole release`, () => {
      const draft = copy(base);
      const first = copy(exercise(draft));
      const second = copy(first);
      first.id = 'fixture_cycle_first';
      second.id = 'fixture_cycle_second';
      for (const item of [first, second]) {
        item.variationOfId = null;
        item.regressionIds = [];
        item.progressionIds = [];
        item.substitutionIds = [];
      }
      if (relationship === 'variationOfId') {
        first.variationOfId = second.id;
        second.variationOfId = first.id;
      } else {
        first[relationship] = [second.id];
        second[relationship] = [first.id];
      }
      draft.exercises.push(first, second);
      expectRejected(draft, new RegExp(`${relationship}: cycle`));
    });
  }
  await check('reciprocal regression/progression links are valid separate directions', () => {
    const draft = copy(base);
    const first = copy(exercise(draft));
    const second = copy(first);
    first.id = 'fixture_easier';
    second.id = 'fixture_harder';
    for (const item of [first, second]) {
      item.variationOfId = null;
      item.regressionIds = [];
      item.progressionIds = [];
      item.substitutionIds = [];
    }
    first.progressionIds = [second.id];
    second.regressionIds = [first.id];
    draft.exercises.push(first, second);
    validateTrainingCatalogue(draft);
  });

  await check('workout prescriptions pin a real exact exercise version', () => {
    const draft = copy(base);
    const item = addWorkout(draft);
    validateTrainingCatalogue(draft);
    item.exerciseVersion += 1;
    expectRejected(draft, /missing exact exercise version/);
    item.exerciseVersion -= 1;
    item.exerciseId = 'missing_fixture_exercise';
    expectRejected(draft, /missing exact exercise version/);
  });
  await check('rep exercises reject duration or simultaneous rep/time targets', () => {
    const draft = copy(base);
    const item = addWorkout(draft);
    item.durationSec = 30;
    expectRejected(draft, /target does not match/);
    delete item.reps;
    expectRejected(draft, /target does not match/);
  });
  await check('duration prescriptions and unilateral per-side values must match the variant', () => {
    const draft = copy(base);
    const item = addWorkout(draft, 'side_plank');
    validateTrainingCatalogue(draft);
    item.perSide = false;
    expectRejected(draft, /perSide must match/);
    item.perSide = true;
    delete item.durationSec;
    item.reps = 20;
    expectRejected(draft, /target does not match/);
  });
  await check('bilateral exercises reject accidental per-side prescriptions', () => {
    const draft = copy(base);
    addWorkout(draft).perSide = true;
    expectRejected(draft, /perSide must match/);
  });
  await check('loaded reps require the matching added load', () => {
    const draft = copy(base);
    const item = addWorkout(draft, 'dumbbell_floor_press');
    validateTrainingCatalogue(draft);
    delete item.loadKg;
    expectRejected(draft, /loaded reps need the matching load/);
    item.assistanceKg = 10;
    expectRejected(draft, /assistance incompatible/);
  });
  await check('assisted prescriptions cannot be confused with added load', () => {
    const draft = copy(base);
    const item = exercise(draft, 'band_assisted_pull_up');
    item.measurementType = 'reps_load';
    const prescription = addWorkout(draft, item.id);
    validateTrainingCatalogue(draft);
    delete prescription.assistanceKg;
    prescription.loadKg = 10;
    expectRejected(draft, /added load incompatible/);
  });
  await check('bodyweight measurement rejects loaded-repetition mode', () => {
    const draft = copy(base);
    exercise(draft).measurementType = 'reps_load';
    expectRejected(draft, /Loaded reps require/);
  });
  await check('zero, nonfinite and negative prescribed work is never accepted', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const draft = copy(base);
      addWorkout(draft).reps = value;
      expectRejected(draft, /reps/);
    }
  });
  await check('prescription and block identities stay unique across a workout', () => {
    const draft = copy(base);
    addWorkout(draft);
    const block = draft.workouts[0]!.blocks[0]!;
    block.items.push(copy(block.items[0]!));
    expectRejected(draft, /items: duplicate/);
    block.items.pop();
    draft.workouts[0]!.blocks.push(copy(block));
    expectRejected(draft, /blocks: duplicate/);
  });
  await check('workout feasibility checks every prescribed exercise and exact version', () => {
    const item = copy(exercise(base, 'dumbbell_bench_press'));
    const workout = syntheticWorkout(item);
    const known = new Map([[item.id, item]]);
    assert.equal(canPerformWorkout(workout, known, new Set(['dumbbell_pair'])), false);
    assert.equal(canPerformWorkout(workout, known, new Set(['dumbbell_pair', 'flat_bench'])), true);
    assert.equal(canPerformWorkout(workout, new Map(), new Set()), false);
    workout.blocks[0]!.items[0]!.exerciseVersion += 1;
    assert.equal(canPerformWorkout(workout, known, new Set(['dumbbell_pair', 'flat_bench'])), false);
  });

  await check('catalogue hashes ignore top-level record ordering', () => {
    const reordered = copy(base);
    reordered.exercises.reverse();
    reordered.muscles.reverse();
    reordered.equipment.reverse();
    reordered.sources.reverse();
    assert.equal(catalogueHash(reordered), catalogueHash(base));
  });
  await check('exercise hash ignores unordered target, alias and equipment alternative ordering', () => {
    const original = copy(exercise(base));
    original.aliases = ['Fixture A', 'Fixture B'];
    original.primaryMuscleIds = ['pectorals', 'triceps'];
    original.secondaryMuscleIds = ['anterior_deltoids', 'abdominals'];
    original.equipmentRequirementGroups = [
      { anyOf: ['flat_bench', 'adjustable_bench'] },
      { anyOf: ['dumbbell_pair'] },
    ];
    original.optionalEquipmentIds = ['exercise_mat', 'wall'];
    const reordered = copy(original);
    reordered.aliases.reverse();
    reordered.primaryMuscleIds.reverse();
    reordered.secondaryMuscleIds.reverse();
    reordered.optionalEquipmentIds.reverse();
    reordered.equipmentRequirementGroups[0]!.anyOf.reverse();
    reordered.equipmentRequirementGroups.reverse();
    assert.equal(exerciseContentHash(reordered), exerciseContentHash(original));
  });
  await check('instruction reordering changes the semantic exercise version hash', () => {
    const item = copy(exercise(base));
    item.instructions = ['First fixture instruction.', 'Second fixture instruction.'];
    const reordered = copy(item);
    reordered.instructions.reverse();
    assert.notEqual(exerciseContentHash(reordered), exerciseContentHash(item));
  });
  await check('editorial approval changes leave semantic exercise content unchanged', () => {
    const item = copy(exercise(base));
    const approved = copy(item);
    approved.review = approval();
    assert.equal(exerciseContentHash(approved), exerciseContentHash(item));
  });
  await check('catalogue release hash records approvals and ordered workout changes', () => {
    assert.notEqual(catalogueHash(approveForTest(base)), catalogueHash(base));
    const draft = copy(base);
    const item = addWorkout(draft);
    const second = copy(item);
    second.id = 'fixture_second_item';
    second.reps = (item.reps ?? 1) + 1;
    draft.workouts[0]!.blocks[0]!.items.push(second);
    const reordered = copy(draft);
    reordered.workouts[0]!.blocks[0]!.items.reverse();
    assert.notEqual(catalogueHash(draft), catalogueHash(reordered));
  });
  await check('repeated hash generation does not mutate input or change result', () => {
    const unchanged = copy(base);
    const first = catalogueHash(base);
    assert.equal(catalogueHash(base), first);
    assert.deepEqual(base, unchanged);
  });

  await check('synthetic completed approvals clear publication blockers only in tests', () => {
    const approved = approveForTest(base);
    assert.deepEqual(publicationBlockers(approved), []);
    assert.doesNotThrow(() => assertPublishable(approved));
    assert.ok(publicationBlockers(base).length > 0);
  });
  await check('approval requires identity, timestamp and evidence', () => {
    const draft = copy(base);
    exercise(draft).review = { ...approval(), reviewer: null };
    expectRejected(draft, /Approval requires/);
    exercise(draft).review = { ...approval(), reviewedAt: null };
    expectRejected(draft, /Approval requires/);
    exercise(draft).review = { ...approval(), evidence: null };
    expectRejected(draft, /Approval requires/);
    exercise(draft).review = { ...approval(), approvedContentHash: null };
    expectRejected(draft, /Approval requires/);
  });
  await check('a new exercise version cannot reuse approval for older instructions', () => {
    const draft = approveForTest(base);
    const item = exercise(draft);
    item.version += 1;
    item.instructions[0] = 'Instructions changed after the recorded synthetic review.';
    // Keep exact workout-version references valid so publication fails for the
    // stale exercise review itself rather than an unrelated reference error.
    for (const workout of draft.workouts) {
      for (const block of workout.blocks) for (const prescription of block.items) {
        if (prescription.exerciseId === item.id) prescription.exerciseVersion = item.version;
      }
      workout.review = { ...approval(), approvedContentHash: workoutContentHash(workout) };
    }
    validateTrainingCatalogue(draft);
    assert.throws(() => assertPublishable(draft), /hash|content|review/i);
  });
  await check('source version and media URL changes invalidate their previous approvals', () => {
    const sourceChanged = approveForTest(base);
    sourceChanged.sources[0]!.version = 'changed-after-review';
    assert.throws(() => assertPublishable(sourceChanged), /hash|source|content/i);

    const mediaChanged = approveForTest(base);
    const asset = addMedia(mediaChanged);
    assert.doesNotThrow(() => assertPublishable(mediaChanged));
    asset.url = 'https://example.test/changed-after-review.mp4';
    assert.throws(() => assertPublishable(mediaChanged), /hash|media|content/i);
  });
  await check('workout target changes invalidate the recorded template approval', () => {
    const draft = approveForTest(base);
    addWorkout(draft);
    const workout = draft.workouts[0]!;
    workout.review = { ...approval(), approvedContentHash: workoutContentHash(workout) };
    assert.doesNotThrow(() => assertPublishable(draft));
    workout.blocks[0]!.items[0]!.reps! += 1;
    assert.throws(() => assertPublishable(draft), /hash|workout|content/i);
  });
  await check('source approval alone cannot publish unreviewed exercise content', () => {
    const draft = approveForTest(base);
    exercise(draft).review.status = 'pending';
    assert.throws(() => assertPublishable(draft), /editorial review not approved/);
  });
  await check('a rejected source blocks every affected release despite exercise approval', () => {
    const draft = approveForTest(base);
    draft.sources[0]!.rights.status = 'rejected';
    assert.throws(() => assertPublishable(draft), /distribution rights not approved/);
  });
  await check('unknown equipment remains a publication blocker after editorial approval', () => {
    const draft = approveForTest(base);
    exercise(draft).equipmentStatus = 'unknown';
    exercise(draft).equipmentRequirementGroups = [];
    validateTrainingCatalogue(draft);
    assert.throws(() => assertPublishable(draft), /equipment requirements unknown/);
  });
  await check('workout editorial review is independent from its exercises', () => {
    const draft = approveForTest(base);
    addWorkout(draft);
    assert.throws(() => assertPublishable(draft), /workout .*editorial review not approved/);
  });
  await check('linked media needs independent available status and rights', () => {
    const draft = approveForTest(base);
    const media = addMedia(draft);
    assert.doesNotThrow(() => assertPublishable(validateTrainingCatalogue(draft)));
    media.rights.status = 'pending';
    assert.throws(() => assertPublishable(draft), /media .*not cleared|media .*rights not approved/);
    media.rights = approval();
    media.status = 'withdrawn';
    assert.throws(() => assertPublishable(draft), /withdrawn|not cleared/);
  });
  await check('media must reference an independently cleared source', () => {
    const draft = approveForTest(base);
    const source = copy(draft.sources[0]!);
    source.id = 'selfcheck_media_source';
    source.rights.status = 'pending';
    draft.sources.push(source);
    addMedia(draft).sourceId = source.id;
    validateTrainingCatalogue(draft);
    assert.throws(() => assertPublishable(draft), /source .*not approved|media .*not cleared/);
  });
  await check('insecure media URLs cannot enter staged content', () => {
    const draft = copy(base);
    addMedia(draft).url = 'http://example.test/insecure.mp4';
    expectRejected(draft, /Media must use HTTPS/);
  });

  await check('import validates malformed input before its first store mutation', async () => {
    const store = new RecordingImportStore();
    await assert.rejects(
      importTrainingCatalogue({ ...copy(base), schemaVersion: 2 }, store),
      /schemaVersion/,
    );
    assert.deepEqual(store.calls, []);
  });
  await check('import validates the complete reference graph before store reservation', async () => {
    const store = new RecordingImportStore();
    const draft = copy(base);
    exercise(draft).primaryMuscleIds = ['missing_fixture_muscle'];
    await assert.rejects(importTrainingCatalogue(draft, store), /unknown reference/);
    assert.deepEqual(store.calls, []);
  });
  await check('unapproved publish request fails before reservation or row writes', async () => {
    const store = new RecordingImportStore();
    await assert.rejects(importTrainingCatalogue(base, store, { publish: true }), /not approved/);
    assert.deepEqual(store.calls, []);
  });
  await check('normal staged import never changes the active release', async () => {
    const store = new RecordingImportStore();
    const result = await importTrainingCatalogue(base, store);
    assert.deepEqual(store.calls, ['begin', 'writeRows', 'complete:false']);
    assert.equal(result.releaseId, base.releaseId);
    assert.equal(result.hash, catalogueHash(base));
    assert.equal(result.published, false);
    assert.equal(store.stored?.status, 'staged');
  });
  await check('approved publication activates strictly after completed row writes', async () => {
    const store = new RecordingImportStore();
    const result = await importTrainingCatalogue(approveForTest(base), store, { publish: true });
    assert.deepEqual(store.calls, ['begin', 'writeRows', 'complete:true', 'activate']);
    assert.equal(result.published, true);
    assert.equal(store.stored?.status, 'published');
  });
  await check('partial row-write failure neither completes nor activates a release', async () => {
    const store = new RecordingImportStore();
    store.failure = 'writeRows';
    await assert.rejects(
      importTrainingCatalogue(approveForTest(base), store, { publish: true }),
      /Fixture row write failure/,
    );
    assert.deepEqual(store.calls, ['begin', 'writeRows']);
    assert.equal(store.stored?.status, 'writing');
  });
  await check('completion failure cannot activate an incompletely marked release', async () => {
    const store = new RecordingImportStore();
    store.failure = 'complete';
    await assert.rejects(
      importTrainingCatalogue(approveForTest(base), store, { publish: true }),
      /Fixture completion failure/,
    );
    assert.deepEqual(store.calls, ['begin', 'writeRows', 'complete:true']);
    assert.equal(store.stored?.status, 'writing');
  });
  await check('retry after row-write failure resumes the same identity safely', async () => {
    const store = new RecordingImportStore();
    store.failure = 'writeRows';
    await assert.rejects(importTrainingCatalogue(base, store), /Fixture row write failure/);
    const reservedHash = store.stored!.hash;
    store.failure = null;
    const result = await importTrainingCatalogue(base, store);
    assert.equal(result.hash, reservedHash);
    assert.deepEqual(store.calls, ['begin', 'writeRows', 'begin', 'writeRows', 'complete:false']);
    assert.equal(store.stored?.status, 'staged');
  });
  await check('identical staged replay skips all row writes and completion', async () => {
    const store = new RecordingImportStore();
    await importTrainingCatalogue(base, store);
    store.calls.length = 0;
    await importTrainingCatalogue(base, store);
    assert.deepEqual(store.calls, ['begin']);
  });
  await check('an already approved staged release can be published without rewriting rows', async () => {
    const approved = approveForTest(base);
    const store = new RecordingImportStore();
    await importTrainingCatalogue(approved, store);
    store.calls.length = 0;
    await importTrainingCatalogue(approved, store, { publish: true });
    assert.deepEqual(store.calls, ['begin', 'complete:true', 'activate']);
  });
  await check('default replay reports the actual already-published release state', async () => {
    const approved = approveForTest(base);
    const store = new RecordingImportStore();
    await importTrainingCatalogue(approved, store, { publish: true });
    store.calls.length = 0;
    const result = await importTrainingCatalogue(approved, store);
    assert.equal(result.published, true);
    assert.equal(store.stored?.status, 'published');
    assert.deepEqual(store.calls, ['begin']);
  });
  await check('activation failure is reported and can retry without rewriting published rows', async () => {
    const approved = approveForTest(base);
    const store = new RecordingImportStore();
    store.failure = 'activate';
    await assert.rejects(
      importTrainingCatalogue(approved, store, { publish: true }),
      /Fixture activation failure/,
    );
    assert.equal(store.stored?.status, 'published');
    store.calls.length = 0;
    store.failure = null;
    await importTrainingCatalogue(approved, store, { publish: true });
    assert.deepEqual(store.calls, ['begin', 'activate']);
  });
  await check('a reserved release hash conflict is rejected before row writes', async () => {
    const store = new RecordingImportStore();
    await importTrainingCatalogue(base, store);
    store.calls.length = 0;
    const changed = copy(base);
    exercise(changed).instructions[0] = 'Changed content under a reserved release identity.';
    await assert.rejects(importTrainingCatalogue(changed, store), /different content/);
    assert.deepEqual(store.calls, ['begin']);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
