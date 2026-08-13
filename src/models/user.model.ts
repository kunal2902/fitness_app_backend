import bcrypt from 'bcrypt';
import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Enums — these strings are the contract with the Flutter client. Changing a
// value here without changing `lib/models/enums.dart` breaks signup.
// ---------------------------------------------------------------------------

export const GENDERS = ['male', 'female'] as const;
export const HEIGHT_UNITS = ['cm', 'in'] as const;
export const WEIGHT_UNITS = ['kg', 'lbs'] as const;

export const FITNESS_GOALS = [
  'build_strength',
  'build_muscle',
  'lose_fat',
  'learn_calisthenics',
  'weight_gain',
  'basic_fitness',
  'yoga',
  'stretching',
] as const;

export const PULLUP_RANGES = ['lt_6', '6_10', '11_15', 'gt_15'] as const;
export const PUSHUP_RANGES = ['lt_11', '11_20', '21_30', 'gt_30'] as const;
export const SQUAT_RANGES = ['lt_21', '21_30', '31_40', 'gt_40'] as const;
export const DIP_RANGES = ['lt_9', '9_15', '16_25', 'gt_25'] as const;

export const FITNESS_LEVELS = [
  'newbie',
  'beginner',
  'intermediate',
  'advanced',
] as const;

export type Gender = (typeof GENDERS)[number];
export type HeightUnit = (typeof HEIGHT_UNITS)[number];
export type WeightUnit = (typeof WEIGHT_UNITS)[number];
export type FitnessGoal = (typeof FITNESS_GOALS)[number];
export type PullUpRange = (typeof PULLUP_RANGES)[number];
export type PushUpRange = (typeof PUSHUP_RANGES)[number];
export type SquatRange = (typeof SQUAT_RANGES)[number];
export type DipRange = (typeof DIP_RANGES)[number];
export type FitnessLevel = (typeof FITNESS_LEVELS)[number];

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface IFitnessProfile {
  gender: Gender;
  /** Canonical height, always centimetres. */
  heightCm: number;
  /** The unit the user prefers to *see*. Display only. */
  heightUnit: HeightUnit;
  /** Canonical weight, always kilograms. */
  weightKg: number;
  weightUnit: WeightUnit;
  goals: FitnessGoal[];
  maxPullUps: PullUpRange;
  maxPushUps: PushUpRange;
  maxSquats: SquatRange;
  maxDips: DipRange;
  fitnessLevel: FitnessLevel;
}

export interface IUser {
  username: string;
  fullName: string;
  email: string;
  passwordHash: string;
  avatarUrl?: string | null;
  isEmailVerified: boolean;
  fitnessProfile: IFitnessProfile;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserMethods {
  comparePassword(candidate: string): Promise<boolean>;
}

export type UserDocument = HydratedDocument<IUser, IUserMethods>;
export type UserModelType = Model<IUser, Record<string, never>, IUserMethods>;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const fitnessProfileSchema = new Schema<IFitnessProfile>(
  {
    gender: { type: String, enum: GENDERS, required: true },

    heightCm: { type: Number, required: true, min: 120, max: 230 },
    heightUnit: { type: String, enum: HEIGHT_UNITS, default: 'cm' },

    weightKg: { type: Number, required: true, min: 30, max: 200 },
    weightUnit: { type: String, enum: WEIGHT_UNITS, default: 'kg' },

    goals: {
      type: [String],
      enum: FITNESS_GOALS,
      required: true,
      validate: {
        validator: (value: string[]) => value.length > 0 && value.length <= 3,
        message: 'Pick between 1 and 3 goals',
      },
    },

    maxPullUps: { type: String, enum: PULLUP_RANGES, required: true },
    maxPushUps: { type: String, enum: PUSHUP_RANGES, required: true },
    maxSquats: { type: String, enum: SQUAT_RANGES, required: true },
    maxDips: { type: String, enum: DIP_RANGES, required: true },
    fitnessLevel: { type: String, enum: FITNESS_LEVELS, required: true },
  },
  { _id: false },
);

const userSchema = new Schema<IUser, UserModelType, IUserMethods>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 20,
      match: /^[a-z0-9][a-z0-9._]*$/,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 60,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: true,
      // Never ships in a query result unless explicitly selected.
      select: false,
    },
    avatarUrl: { type: String, default: null },
    isEmailVerified: { type: Boolean, default: false },
    fitnessProfile: { type: fitnessProfileSchema, required: true },
    lastLoginAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

/** Hash on the way in, so no caller can accidentally store a plaintext. */
// Async middleware: returning resolves the hook, so there is no `next` to
// call — and no risk of calling it twice.
userSchema.pre('save', async function hashPassword(this: UserDocument) {
  if (!this.isModified('passwordHash')) return;
  this.passwordHash = await bcrypt.hash(this.passwordHash, env.bcryptRounds);
});

userSchema.methods.comparePassword = async function comparePassword(
  this: UserDocument,
  candidate: string,
): Promise<boolean> {
  if (!this.passwordHash) return false;
  return bcrypt.compare(candidate, this.passwordHash);
};

export const User: UserModelType =
  (mongoose.models.User as UserModelType | undefined) ??
  mongoose.model<IUser, UserModelType>('User', userSchema);

// ---------------------------------------------------------------------------
// API shape
// ---------------------------------------------------------------------------

/**
 * Exactly what the client receives — mirrors `UserModel.fromJson` in
 * `lib/models/user_model.dart`. Note `id` (not `_id`) and no `passwordHash`;
 * the schema's `toJSON` transform is what produces this.
 */
export interface PublicUser {
  id: string;
  username: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
  isEmailVerified: boolean;
  fitnessProfile: IFitnessProfile;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicUser(user: UserDocument): PublicUser {
  return user.toJSON() as unknown as PublicUser;
}
