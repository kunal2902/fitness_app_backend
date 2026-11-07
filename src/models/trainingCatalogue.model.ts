import mongoose, { Schema, type Model } from 'mongoose';

export interface CatalogueRow {
  releaseId: string;
  canonicalId: string;
  contentVersion: number;
  contentHash: string;
  payload: Record<string, unknown>;
}

/** Import writes only validated immutable rows. Readers must select the active release. */
function rowModel(name: string, collection: string): Model<CatalogueRow> {
  if (mongoose.models[name]) return mongoose.models[name] as Model<CatalogueRow>;
  const schema = new Schema<CatalogueRow>({
    releaseId: { type: String, required: true, immutable: true },
    canonicalId: { type: String, required: true, immutable: true },
    contentVersion: { type: Number, required: true, min: 1, immutable: true },
    contentHash: { type: String, required: true, immutable: true },
    payload: { type: Schema.Types.Mixed, required: true, immutable: true },
  }, { collection, timestamps: true, strict: 'throw' });
  schema.index({ releaseId: 1, canonicalId: 1 }, { unique: true });
  schema.index({ canonicalId: 1, contentVersion: 1 });
  return mongoose.model<CatalogueRow>(name, schema);
}

export const TrainingMuscle = rowModel('TrainingMuscle', 'training_muscles');
export const TrainingEquipment = rowModel('TrainingEquipment', 'training_equipment');
export const TrainingExercise = rowModel('TrainingExercise', 'training_exercises');
export const TrainingMediaAsset = rowModel('TrainingMediaAsset', 'training_media_assets');
export const TrainingWorkout = rowModel('TrainingWorkout', 'training_workouts');
export const TrainingSource = rowModel('TrainingSource', 'training_sources');

export interface CatalogueRelease {
  releaseId: string;
  catalogueVersion: number;
  schemaVersion: number;
  hash: string;
  status: 'writing' | 'staged' | 'published';
  counts: Record<string, number>;
  completedAt: Date | null;
}

const releaseSchema = new Schema<CatalogueRelease>({
  releaseId: { type: String, required: true, unique: true, immutable: true },
  catalogueVersion: { type: Number, required: true, min: 1, immutable: true },
  schemaVersion: { type: Number, required: true, min: 1, immutable: true },
  hash: { type: String, required: true, immutable: true },
  status: { type: String, enum: ['writing', 'staged', 'published'], required: true },
  counts: { type: Schema.Types.Mixed, required: true, immutable: true },
  completedAt: { type: Date, default: null },
}, { collection: 'training_catalogue_releases', timestamps: true, strict: 'throw' });

export const TrainingCatalogueRelease: Model<CatalogueRelease> =
  (mongoose.models.TrainingCatalogueRelease as Model<CatalogueRelease> | undefined) ??
  mongoose.model<CatalogueRelease>('TrainingCatalogueRelease', releaseSchema);

interface CatalogueState {
  key: string;
  releaseId: string;
  catalogueVersion: number;
  hash: string;
}

const stateSchema = new Schema<CatalogueState>({
  key: { type: String, required: true, unique: true },
  releaseId: { type: String, required: true },
  catalogueVersion: { type: Number, required: true, min: 1 },
  hash: { type: String, required: true },
}, { collection: 'training_catalogue_state', timestamps: true, strict: 'throw' });

export const TrainingCatalogueState: Model<CatalogueState> =
  (mongoose.models.TrainingCatalogueState as Model<CatalogueState> | undefined) ??
  mongoose.model<CatalogueState>('TrainingCatalogueState', stateSchema);

interface ContentIdentity {
  kind: 'exercise' | 'workout';
  canonicalId: string;
  contentVersion: number;
  contentHash: string;
}

const identitySchema = new Schema<ContentIdentity>({
  kind: { type: String, enum: ['exercise', 'workout'], required: true, immutable: true },
  canonicalId: { type: String, required: true, immutable: true },
  contentVersion: { type: Number, required: true, min: 1, immutable: true },
  contentHash: { type: String, required: true, immutable: true },
}, { collection: 'training_content_identities', strict: 'throw' });
identitySchema.index({ kind: 1, canonicalId: 1, contentVersion: 1 }, { unique: true });

export const TrainingContentIdentity: Model<ContentIdentity> =
  (mongoose.models.TrainingContentIdentity as Model<ContentIdentity> | undefined) ??
  mongoose.model<ContentIdentity>('TrainingContentIdentity', identitySchema);
