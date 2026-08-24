import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

/**
 * A coach the member can book and talk to.
 *
 * Kept in its own collection rather than bolted onto `User` because a
 * professional record has a completely different shape and lifecycle — it
 * is curated content (portfolio, credentials, rates) that happens to be
 * attached to a login, not part of the login itself.
 */

export const PROFESSIONAL_SPECIALITIES = [
  'strength',
  'calisthenics',
  'mobility',
  'nutrition',
  'rehab',
  'yoga',
  'weight_loss',
  'muscle_gain',
] as const;

export type ProfessionalSpeciality =
  (typeof PROFESSIONAL_SPECIALITIES)[number];

export interface ICertification {
  title: string;
  issuer: string;
  year: number;
  credentialUrl?: string | null;
}

export interface ITransformation {
  clientName: string;
  /** e.g. "12 weeks". Free text: programmes vary. */
  durationLabel: string;
  summary: string;
  beforeImageUrl?: string | null;
  afterImageUrl?: string | null;
  highlights: string[];
}

export interface IAchievement {
  title: string;
  description: string;
  year?: number | null;
}

export interface IProfessional {
  /** The login this profile belongs to. */
  user: mongoose.Types.ObjectId;

  displayName: string;
  headline: string;
  bio: string;
  avatarUrl?: string | null;

  specialities: ProfessionalSpeciality[];
  languages: string[];
  yearsExperience: number;

  certifications: ICertification[];
  transformations: ITransformation[];
  achievements: IAchievement[];

  /** Minor units (paise/cents) to avoid float money. */
  sessionRateMinor: number;
  currency: string;

  ratingAverage: number;
  ratingCount: number;
  clientsCoached: number;

  /** Accepting new conversations and calls. */
  isAcceptingClients: boolean;
  /** Hidden from the list without deleting the record. */
  isPublished: boolean;

  sortOrder: number;

  createdAt: Date;
  updatedAt: Date;
}

export type ProfessionalDocument = HydratedDocument<IProfessional>;

const certificationSchema = new Schema<ICertification>(
  {
    title: { type: String, required: true, trim: true },
    issuer: { type: String, required: true, trim: true },
    year: { type: Number, required: true, min: 1950, max: 2100 },
    credentialUrl: { type: String, default: null },
  },
  { _id: false },
);

const transformationSchema = new Schema<ITransformation>(
  {
    clientName: { type: String, required: true, trim: true },
    durationLabel: { type: String, required: true, trim: true },
    summary: { type: String, required: true, trim: true },
    beforeImageUrl: { type: String, default: null },
    afterImageUrl: { type: String, default: null },
    highlights: { type: [String], default: [] },
  },
  { _id: false },
);

const achievementSchema = new Schema<IAchievement>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    year: { type: Number, default: null },
  },
  { _id: false },
);

const professionalSchema = new Schema<IProfessional>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },

    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    headline: { type: String, required: true, trim: true, maxlength: 120 },
    bio: { type: String, required: true, trim: true, maxlength: 2000 },
    avatarUrl: { type: String, default: null },

    specialities: {
      type: [String],
      enum: PROFESSIONAL_SPECIALITIES,
      default: [],
    },
    languages: { type: [String], default: ['English'] },
    yearsExperience: { type: Number, default: 0, min: 0, max: 70 },

    certifications: { type: [certificationSchema], default: [] },
    transformations: { type: [transformationSchema], default: [] },
    achievements: { type: [achievementSchema], default: [] },

    sessionRateMinor: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR', uppercase: true, maxlength: 3 },

    ratingAverage: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    clientsCoached: { type: Number, default: 0, min: 0 },

    isAcceptingClients: { type: Boolean, default: true },
    isPublished: { type: Boolean, default: true },

    sortOrder: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

// The list screen sorts by these two, so index them together.
professionalSchema.index({ isPublished: 1, sortOrder: 1 });

export const Professional: Model<IProfessional> =
  (mongoose.models.Professional as Model<IProfessional> | undefined) ??
  mongoose.model<IProfessional>('Professional', professionalSchema);

/**
 * The shape sent to the client. Mirrors `Professional.fromJson` in
 * `lib/models/professional.dart`.
 */
export interface PublicProfessional {
  id: string;
  userId: string;
  displayName: string;
  headline: string;
  bio: string;
  avatarUrl: string | null;
  specialities: ProfessionalSpeciality[];
  languages: string[];
  yearsExperience: number;
  certifications: ICertification[];
  transformations: ITransformation[];
  achievements: IAchievement[];
  sessionRateMinor: number;
  currency: string;
  ratingAverage: number;
  ratingCount: number;
  clientsCoached: number;
  isAcceptingClients: boolean;
  isOnline: boolean;
  lastSeenAt: string | null;
}

export function toPublicProfessional(
  doc: ProfessionalDocument,
  presence: { isOnline: boolean; lastSeenAt: Date | null },
): PublicProfessional {
  return {
    id: doc._id.toString(),
    userId: doc.user.toString(),
    displayName: doc.displayName,
    headline: doc.headline,
    bio: doc.bio,
    avatarUrl: doc.avatarUrl ?? null,
    specialities: doc.specialities,
    languages: doc.languages,
    yearsExperience: doc.yearsExperience,
    certifications: doc.certifications,
    transformations: doc.transformations,
    achievements: doc.achievements,
    sessionRateMinor: doc.sessionRateMinor,
    currency: doc.currency,
    ratingAverage: doc.ratingAverage,
    ratingCount: doc.ratingCount,
    clientsCoached: doc.clientsCoached,
    isAcceptingClients: doc.isAcceptingClients,
    isOnline: presence.isOnline,
    lastSeenAt: presence.lastSeenAt?.toISOString() ?? null,
  };
}
