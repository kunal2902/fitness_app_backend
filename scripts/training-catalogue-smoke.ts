/** Mongo-backed checks in a fresh, isolated database; never seeds application data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';

import {
  TrainingCatalogueRelease, TrainingCatalogueState, TrainingEquipment,
  TrainingExercise, TrainingMediaAsset, TrainingMuscle, TrainingSource,
  TrainingWorkout,
} from '../src/models/trainingCatalogue.model.js';
import { importTrainingCatalogue, MongoCatalogueImportStore, readActiveTrainingCatalogue } from '../src/training/catalogue-import.js';
import { exerciseContentHash, reviewedContentHash, validateTrainingCatalogue, workoutContentHash } from '../src/training/catalogue-policy.js';
import type { TrainingCatalogue, TrainingReview } from '../src/training/catalogue.schema.js';

let passed = 0;
const databaseName = `fitness_training_smoke_${randomUUID().replaceAll('-', '')}`;
const fixture = validateTrainingCatalogue(JSON.parse(await readFile(fileURLToPath(new URL('../data/training/starter-catalogue.json', import.meta.url)), 'utf8')));
const syntheticApproval = (): TrainingReview => ({
  status: 'approved', reviewer: 'SYNTHETIC DATABASE TEST ONLY',
  reviewedAt: '2026-11-07T00:00:00.000Z', evidence: 'Isolated smoke-test fixture; not an approval of production content.',
  approvedContentHash: 'a'.repeat(64),
});

function approvedFixture(releaseId: string, catalogueVersion: number): TrainingCatalogue {
  const result = structuredClone(fixture);
  result.releaseId = releaseId;
  result.catalogueVersion = catalogueVersion;
  result.sources.forEach((source) => { source.rights = { ...syntheticApproval(), approvedContentHash: reviewedContentHash(source) }; });
  result.exercises.forEach((exercise) => { exercise.review = { ...syntheticApproval(), approvedContentHash: exerciseContentHash(exercise) }; });
  result.workouts.forEach((workout) => { workout.review = { ...syntheticApproval(), approvedContentHash: workoutContentHash(workout) }; });
  return result;
}

async function check(name: string, run: () => Promise<void>) {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main() {
  // dbName overrides any path in MONGO_TEST_URI. We never read the app's .env.
  await mongoose.connect(process.env.MONGO_TEST_URI ?? 'mongodb://127.0.0.1:27017', {
    dbName: databaseName, serverSelectionTimeoutMS: 5_000,
  });
  const store = new MongoCatalogueImportStore();
  try {
    await store.initialize();
    await check('draft staging is private and re-import keeps one set of rows', async () => {
      await importTrainingCatalogue(fixture, store);
      assert.equal(await readActiveTrainingCatalogue(), null);
      await importTrainingCatalogue(fixture, store);
      assert.equal(await TrainingCatalogueRelease.countDocuments(), 1);
      assert.equal(await TrainingExercise.countDocuments(), fixture.exercises.length);
      assert.equal(await TrainingWorkout.countDocuments(), fixture.workouts.length);
      assert.equal(await TrainingMuscle.countDocuments(), fixture.muscles.length);
      assert.equal(await TrainingEquipment.countDocuments(), fixture.equipment.length);
      assert.equal(await TrainingSource.countDocuments(), fixture.sources.length);
      assert.equal(await TrainingMediaAsset.countDocuments(), fixture.media.length);
    });
    await check('same release with changed content cannot overwrite its snapshot', async () => {
      const changed = structuredClone(fixture);
      changed.exercises[0]!.name = 'Changed same release';
      await assert.rejects(importTrainingCatalogue(changed, store), /different content/);
      const row = await TrainingExercise.findOne({ releaseId: fixture.releaseId, canonicalId: fixture.exercises[0]!.id }).lean();
      assert.equal(row?.payload.name, fixture.exercises[0]!.name);
    });
    await check('unapproved publication writes nothing and never sets an active release', async () => {
      const unapproved = structuredClone(fixture);
      unapproved.releaseId = 'smoke_unapproved';
      await assert.rejects(importTrainingCatalogue(unapproved, store, { publish: true }), /not approved|not cleared/);
      assert.equal(await TrainingCatalogueRelease.exists({ releaseId: unapproved.releaseId }), null);
      assert.equal(await TrainingCatalogueState.countDocuments(), 0);
    });

    const approved = approvedFixture('smoke_approved', 2);
    await check('approved synthetic release activates and reads a complete snapshot', async () => {
      await importTrainingCatalogue(approved, store, { publish: true });
      const active = await readActiveTrainingCatalogue();
      assert.equal(active?.releaseId, approved.releaseId);
      assert.equal(active?.exercises.length, fixture.exercises.length);
      assert.equal(active?.workouts.length, fixture.workouts.length);
      await importTrainingCatalogue(approved, store, { publish: true });
      assert.equal(await TrainingCatalogueState.countDocuments(), 1);
      assert.equal(await TrainingExercise.countDocuments({ releaseId: approved.releaseId }), fixture.exercises.length);
      const replay = await importTrainingCatalogue(approved, store);
      assert.equal(replay.published, true);
      assert.equal(replay.activated, false);
    });
    await check('a semantic change needs a new exercise version across releases', async () => {
      const conflicting = approvedFixture('smoke_conflicting_version', 3);
      conflicting.exercises[0]!.instructions[0] = 'Changed exercise content without a version bump.';
      await assert.rejects(importTrainingCatalogue(conflicting, store), /increment its version/);
      assert.equal((await readActiveTrainingCatalogue())?.releaseId, approved.releaseId);
    });
    await check('a workout prescription change needs a new workout version', async () => {
      const conflicting = approvedFixture('smoke_workout_conflict', 3);
      conflicting.workouts[0]!.estimatedDurationMin += 1;
      await assert.rejects(importTrainingCatalogue(conflicting, store), /increment its version/);
    });
    await check('older or equal-version different releases cannot replace the active pointer', async () => {
      const older = approvedFixture('smoke_older', 1);
      await assert.rejects(importTrainingCatalogue(older, store, { publish: true }), /Activation rejected/);
      const equal = approvedFixture('smoke_equal', 2);
      await assert.rejects(importTrainingCatalogue(equal, store, { publish: true }), /Activation rejected/);
      assert.equal((await readActiveTrainingCatalogue())?.releaseId, approved.releaseId);
    });
    await check('publication replay rechecks stored rows before replacing a healthy active release', async () => {
      const tampered = approvedFixture('smoke_tampered_staging', 3);
      await importTrainingCatalogue(tampered, store);
      await TrainingExercise.collection.updateOne({ releaseId: tampered.releaseId }, { $set: { 'payload.name': 'Changed after staging' } });
      await assert.rejects(importTrainingCatalogue(tampered, store, { publish: true }), /not approved|integrity/);
      assert.equal((await readActiveTrainingCatalogue())?.releaseId, approved.releaseId);
    });
    await check('failure before completion leaves old active data; retry completes safely', async () => {
      const next = approvedFixture('smoke_interrupted', 3);
      class InterruptedStore extends MongoCatalogueImportStore {
        override async writeRows(catalogue: TrainingCatalogue) {
          await super.writeRows(catalogue);
          throw new Error('Simulated write interruption before completion');
        }
      }
      await assert.rejects(importTrainingCatalogue(next, new InterruptedStore(), { publish: true }), /Simulated/);
      assert.equal((await TrainingCatalogueRelease.findOne({ releaseId: next.releaseId }).lean())?.status, 'writing');
      assert.equal((await readActiveTrainingCatalogue())?.releaseId, approved.releaseId);
      await importTrainingCatalogue(next, store, { publish: true });
      assert.equal((await readActiveTrainingCatalogue())?.releaseId, next.releaseId);
      assert.equal(await TrainingExercise.countDocuments({ releaseId: next.releaseId }), fixture.exercises.length);
    });
    await check('active reader refuses tampered data rather than leaking a broken snapshot', async () => {
      const state = await TrainingCatalogueState.findOne({ key: 'active' }).lean();
      assert.ok(state);
      await TrainingExercise.collection.updateOne({ releaseId: state.releaseId }, { $set: { 'payload.name': 'Tampered record' } });
      await assert.rejects(readActiveTrainingCatalogue(), /integrity check|not approved/);
    });
    console.log(`\n${passed} training catalogue database checks passed.`);
  } finally {
    // Only drop this process's own fresh test database after checking its name.
    if (mongoose.connection.name !== databaseName || !/^fitness_training_smoke_[a-f0-9]{32}$/.test(databaseName)) {
      throw new Error('Refusing cleanup outside the isolated training smoke database');
    }
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Training catalogue smoke test failed');
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  process.exitCode = 1;
});
