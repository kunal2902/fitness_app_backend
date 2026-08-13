import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

/**
 * One row per issued refresh token.
 *
 * Storing them lets us do two things a stateless JWT cannot: revoke a
 * single device on logout, and detect reuse of an already-rotated token
 * (a strong signal the token was stolen).
 */
export interface IRefreshToken {
  user: mongoose.Types.ObjectId;
  /** The token's `jti` claim — the token string itself is never stored. */
  jti: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  /** Set when this token is rotated, pointing at its successor. */
  replacedByJti?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RefreshTokenDocument = HydratedDocument<IRefreshToken>;

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    jti: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedByJti: { type: String, default: null },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: true },
);

// Mongo sweeps expired rows on its own — no cron needed.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken: Model<IRefreshToken> =
  (mongoose.models.RefreshToken as Model<IRefreshToken> | undefined) ??
  mongoose.model<IRefreshToken>('RefreshToken', refreshTokenSchema);
