import {
  TrainingCatalogueRelease,
  TrainingCatalogueState,
  TrainingContentIdentity,
  TrainingEquipment,
  TrainingExercise,
  TrainingMediaAsset,
  TrainingMuscle,
  TrainingSource,
  TrainingWorkout,
} from '../models/trainingCatalogue.model.js';
import {
  assertPublishable,
  catalogueHash,
  contentHash,
  exerciseContentHash,
  validateTrainingCatalogue,
  workoutContentHash,
} from './catalogue-policy.js';
import type { TrainingCatalogue } from './catalogue.schema.js';

export interface StoredRelease {
  releaseId: string;
  hash: string;
  status: 'writing' | 'staged' | 'published';
}

export interface CatalogueImportStore {
  begin(catalogue: TrainingCatalogue, hash: string): Promise<StoredRelease>;
  writeRows(catalogue: TrainingCatalogue): Promise<void>;
  complete(releaseId: string, hash: string, publish: boolean): Promise<void>;
  activate(catalogue: TrainingCatalogue, hash: string): Promise<void>;
}

/** Validates before the first write; activation is always the last operation. */
export async function importTrainingCatalogue(
  raw: unknown,
  store: CatalogueImportStore,
  options: { publish?: boolean } = {},
) {
  const catalogue = validateTrainingCatalogue(raw);
  const hash = catalogueHash(catalogue);
  if (options.publish) assertPublishable(catalogue);
  const release = await store.begin(catalogue, hash);
  if (release.hash !== hash) throw new Error(`Release ${catalogue.releaseId} already has different content; use a new releaseId`);
  if (release.status === 'writing') {
    await store.writeRows(catalogue);
    await store.complete(catalogue.releaseId, hash, Boolean(options.publish));
  } else if (options.publish && release.status === 'staged') {
    await store.complete(catalogue.releaseId, hash, true);
  }
  if (options.publish) await store.activate(catalogue, hash);
  return { releaseId: catalogue.releaseId, hash, published: release.status === 'published' || Boolean(options.publish), activated: Boolean(options.publish) };
}

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

export class MongoCatalogueImportStore implements CatalogueImportStore {
  async initialize(): Promise<void> {
    await Promise.all([
      TrainingCatalogueRelease, TrainingCatalogueState, TrainingContentIdentity,
      TrainingMuscle, TrainingEquipment, TrainingExercise, TrainingMediaAsset,
      TrainingSource, TrainingWorkout,
    ].map((model) => model.init()));
  }

  async begin(catalogue: TrainingCatalogue, hash: string): Promise<StoredRelease> {
    const counts = Object.fromEntries((['sources', 'muscles', 'equipment', 'media', 'exercises', 'workouts'] as const).map((key) => [key, catalogue[key].length]));
    try {
      await TrainingCatalogueRelease.updateOne({ releaseId: catalogue.releaseId }, {
        $setOnInsert: { releaseId: catalogue.releaseId, catalogueVersion: catalogue.catalogueVersion, schemaVersion: catalogue.schemaVersion, hash, status: 'writing', counts, completedAt: null },
      }, { upsert: true });
    } catch (error) {
      if (!duplicateKey(error)) throw error;
    }
    const release = await TrainingCatalogueRelease.findOne({ releaseId: catalogue.releaseId }).lean();
    if (!release) throw new Error('Catalogue release reservation was not persisted');
    if (release.hash !== hash) throw new Error(`Release ${catalogue.releaseId} already has different content; use a new releaseId`);
    return release;
  }

  async writeRows(catalogue: TrainingCatalogue): Promise<void> {
    // Reserve immutable semantic identities before storing release-scoped rows.
    for (const [kind, records] of [['exercise', catalogue.exercises], ['workout', catalogue.workouts]] as const) {
      for (const record of records) {
        const hash = kind === 'exercise'
          ? exerciseContentHash(record as TrainingCatalogue['exercises'][number])
          : workoutContentHash(record as TrainingCatalogue['workouts'][number]);
        const key = { kind, canonicalId: record.id, contentVersion: record.version };
        try {
          await TrainingContentIdentity.updateOne(key, { $setOnInsert: { ...key, contentHash: hash } }, { upsert: true });
        } catch (error) {
          if (!duplicateKey(error)) throw error;
        }
        const existing = await TrainingContentIdentity.findOne(key).lean();
        if (existing?.contentHash !== hash) throw new Error(`${kind} ${record.id} v${record.version} has changed; increment its version`);
      }
    }
    const collections = [
      [TrainingSource, catalogue.sources], [TrainingMuscle, catalogue.muscles],
      [TrainingEquipment, catalogue.equipment], [TrainingMediaAsset, catalogue.media],
      [TrainingExercise, catalogue.exercises], [TrainingWorkout, catalogue.workouts],
    ] as const;
    for (const [model, records] of collections) {
      if (records.length > 0) await model.bulkWrite(records.map((record) => ({
        updateOne: {
          filter: { releaseId: catalogue.releaseId, canonicalId: record.id },
          update: { $setOnInsert: {
            releaseId: catalogue.releaseId,
            canonicalId: record.id,
            contentVersion: 'version' in record && typeof record.version === 'number' ? record.version : catalogue.catalogueVersion,
            contentHash: contentHash(record),
            payload: record,
          } },
          upsert: true,
        },
      })), { ordered: true });
      // Detect partial/corrupted releases before they can become active.
      const persisted = await model.find({ releaseId: catalogue.releaseId }).lean();
      const expected = new Map(records.map((record) => [record.id, contentHash(record)]));
      if (persisted.length !== records.length || persisted.some((row) => expected.get(row.canonicalId) !== contentHash(row.payload))) {
        throw new Error(`Stored ${model.collection.collectionName} rows do not match release ${catalogue.releaseId}`);
      }
    }
  }

  async complete(releaseId: string, hash: string, publish: boolean): Promise<void> {
    const result = await TrainingCatalogueRelease.updateOne(
      { releaseId, hash, status: { $in: publish ? ['writing', 'staged'] : ['writing'] } },
      { $set: { status: publish ? 'published' : 'staged', completedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      const current = await TrainingCatalogueRelease.findOne({ releaseId, hash }).lean();
      if (!current || (publish ? current.status !== 'published' : current.status === 'writing')) throw new Error('Catalogue completion did not persist');
    }
  }

  async activate(catalogue: TrainingCatalogue, hash: string): Promise<void> {
    // Revalidate existing staged/published snapshots too. A replay must not
    // activate a row set that was removed or changed after its first import.
    const persisted = await readPublishedTrainingRelease(catalogue.releaseId, hash);
    if (persisted.catalogueVersion !== catalogue.catalogueVersion) throw new Error('Catalogue version does not match its stored release');
    // A version condition prevents a delayed old importer replacing a newer
    // catalogue. The unique key makes a concurrent older upsert fail safely.
    try {
      await TrainingCatalogueState.updateOne(
        { key: 'active', $or: [
          { catalogueVersion: { $lt: catalogue.catalogueVersion } },
          { catalogueVersion: catalogue.catalogueVersion, hash },
        ] },
        { $set: { key: 'active', releaseId: catalogue.releaseId, catalogueVersion: catalogue.catalogueVersion, hash } },
        { upsert: true },
      );
    } catch (error) {
      if (duplicateKey(error)) throw new Error('Activation rejected: an equal-version different catalogue or a newer release is already active');
      throw error;
    }
  }
}

/** Future API readers must call this, never query every staged exercise. */
export async function readActiveTrainingCatalogue(): Promise<TrainingCatalogue | null> {
  const active = await TrainingCatalogueState.findOne({ key: 'active' }).lean();
  if (!active) return null;
  const catalogue = await readPublishedTrainingRelease(active.releaseId, active.hash);
  if (catalogue.catalogueVersion !== active.catalogueVersion) throw new Error('Active catalogue version does not match its release');
  return catalogue;
}

async function readPublishedTrainingRelease(releaseId: string, hash: string): Promise<TrainingCatalogue> {
  const release = await TrainingCatalogueRelease.findOne({ releaseId, hash, status: 'published' }).lean();
  if (!release) throw new Error('Only a complete published catalogue may be read or activated');
  const [sources, muscles, equipment, media, exercises, workouts] = await Promise.all(
    [TrainingSource, TrainingMuscle, TrainingEquipment, TrainingMediaAsset, TrainingExercise, TrainingWorkout].map((model) => model.find({ releaseId }).sort({ canonicalId: 1 }).lean()),
  );
  const catalogue = validateTrainingCatalogue({
    schemaVersion: release.schemaVersion, releaseId: release.releaseId, catalogueVersion: release.catalogueVersion,
    sources: sources!.map((row) => row.payload), muscles: muscles!.map((row) => row.payload),
    equipment: equipment!.map((row) => row.payload), media: media!.map((row) => row.payload),
    exercises: exercises!.map((row) => row.payload), workouts: workouts!.map((row) => row.payload),
  });
  assertPublishable(catalogue);
  if (catalogueHash(catalogue) !== hash) throw new Error('Catalogue integrity check failed');
  return catalogue;
}
