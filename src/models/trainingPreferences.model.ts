import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { TRAINING_LEVELS } from '../training/catalogue.schema.js';

export const TRAINING_LOCATIONS = ['home', 'park', 'gym', 'other'] as const;

export interface EquipmentProfile {
  id: string;
  name: string;
  equipmentIds: string[];
}

export interface TrainingPreferences {
  revision: number;
  equipmentProfiles: EquipmentProfile[];
  activeEquipmentProfileId: string | null;
  level: (typeof TRAINING_LEVELS)[number] | null;
  sessionDurationMin: number | null;
  preferredLocation: (typeof TRAINING_LOCATIONS)[number] | null;
  timezone: string | null;
  currentGoalId: string | null;
}

interface StoredTrainingPreferences extends Omit<TrainingPreferences, 'currentGoalId'> {
  /** The account ID is also the collection's unique primary key. */
  _id: Types.ObjectId;
  currentGoalId: Types.ObjectId | null;
}

const equipmentProfileSchema = new Schema<EquipmentProfile>({
  id: { type: String, required: true },
  name: { type: String, required: true },
  equipmentIds: { type: [String], default: [] },
}, { _id: false, strict: 'throw' });

const trainingPreferencesSchema = new Schema<StoredTrainingPreferences>({
  _id: { type: Schema.Types.ObjectId, required: true },
  revision: { type: Number, required: true, min: 1 },
  equipmentProfiles: { type: [equipmentProfileSchema], default: [] },
  activeEquipmentProfileId: { type: String, default: null },
  level: { type: String, enum: TRAINING_LEVELS, default: null },
  sessionDurationMin: { type: Number, min: 5, max: 180, default: null },
  preferredLocation: { type: String, enum: TRAINING_LOCATIONS, default: null },
  timezone: { type: String, default: null },
  currentGoalId: { type: Schema.Types.ObjectId, default: null },
}, { collection: 'training_preferences', timestamps: true, strict: 'throw' });

export const MemberTrainingPreferences =
  (mongoose.models.MemberTrainingPreferences as Model<StoredTrainingPreferences> | undefined) ??
  mongoose.model<StoredTrainingPreferences>('MemberTrainingPreferences', trainingPreferencesSchema);
