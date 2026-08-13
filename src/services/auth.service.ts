import crypto from 'node:crypto';

import { RefreshToken } from '../models/refreshToken.model.js';
import {
  User,
  toPublicUser,
  type PublicUser,
  type UserDocument,
} from '../models/user.model.js';
import { ApiError } from '../utils/apiError.js';
import {
  durationToMs,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  type TokenPair,
} from '../utils/jwt.js';
import { env } from '../config/env.js';
import type { LoginInput, SignupInput } from '../validators/auth.validator.js';

export interface SessionContext {
  userAgent?: string | null;
  ip?: string | null;
}

export interface AuthResult {
  user: PublicUser;
  tokens: TokenPair;
}

/**
 * All auth business logic. Controllers stay thin: parse, delegate, respond.
 */
export const authService = {
  /**
   * Creates the account and its fitness profile in a single write, then
   * issues a token pair — the client is signed in the moment signup returns.
   */
  async signup(input: SignupInput, ctx: SessionContext): Promise<AuthResult> {
    const [usernameTaken, emailTaken] = await Promise.all([
      User.exists({ username: input.username }),
      User.exists({ email: input.email }),
    ]);

    const conflicts: Record<string, string> = {};
    if (usernameTaken) conflicts.username = 'That username is taken';
    if (emailTaken) conflicts.email = 'An account with this email already exists';
    if (Object.keys(conflicts).length > 0) {
      throw ApiError.conflict(
        'Those details are already in use',
        usernameTaken && emailTaken
          ? 'CREDENTIALS_TAKEN'
          : usernameTaken
            ? 'USERNAME_TAKEN'
            : 'EMAIL_TAKEN',
        conflicts,
      );
    }

    let user: UserDocument;
    try {
      // `passwordHash` receives the plaintext; the pre-save hook hashes it.
      user = await User.create({
        username: input.username,
        fullName: input.fullName,
        email: input.email,
        passwordHash: input.password,
        fitnessProfile: input.fitnessProfile,
      });
    } catch (error) {
      // Two requests can pass the check above at the same time; the unique
      // index is the real guard, so translate its error properly.
      if (isDuplicateKeyError(error)) {
        throw ApiError.conflict(
          'Those details are already in use',
          'CREDENTIALS_TAKEN',
          duplicateKeyFields(error),
        );
      }
      throw error;
    }

    const tokens = await this.issueTokens(user, ctx);
    return { user: toPublicUser(user), tokens };
  },

  async login(input: LoginInput, ctx: SessionContext): Promise<AuthResult> {
    const identifier = input.identifier.toLowerCase();
    const user = await User.findOne({
      $or: [{ email: identifier }, { username: identifier }],
    }).select('+passwordHash');

    // Same message either way — never reveal which half was wrong.
    const invalid = ApiError.unauthorized(
      'Incorrect username or password',
      'INVALID_CREDENTIALS',
    );

    if (!user) throw invalid;

    const matches = await user.comparePassword(input.password);
    if (!matches) throw invalid;

    user.lastLoginAt = new Date();
    await user.save({ validateBeforeSave: false });

    const tokens = await this.issueTokens(user, ctx);
    return { user: toPublicUser(user), tokens };
  },

  /**
   * Rotates the refresh token: the presented one is retired and a fresh
   * pair issued. Presenting an already-rotated token revokes the whole
   * chain, on the assumption it leaked.
   */
  async refresh(token: string, ctx: SessionContext): Promise<AuthResult> {
    const payload = verifyRefreshToken(token);
    const stored = await RefreshToken.findOne({ jti: payload.jti });

    if (!stored) {
      throw ApiError.unauthorized('Session not recognised', 'REFRESH_UNKNOWN');
    }

    if (stored.revokedAt) {
      await RefreshToken.updateMany(
        { user: stored.user, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      throw ApiError.unauthorized(
        'Session expired. Please sign in again.',
        'REFRESH_REUSED',
      );
    }

    const user = await User.findById(stored.user);
    if (!user) {
      throw ApiError.unauthorized('Account no longer exists', 'USER_GONE');
    }

    const tokens = await this.issueTokens(user, ctx);
    const newJti = verifyRefreshToken(tokens.refreshToken).jti;

    stored.revokedAt = new Date();
    stored.replacedByJti = newJti;
    await stored.save();

    return { user: toPublicUser(user), tokens };
  },

  /** Revokes one device's refresh token. Idempotent by design. */
  async logout(token?: string): Promise<void> {
    if (!token) return;
    try {
      const payload = verifyRefreshToken(token);
      await RefreshToken.updateOne(
        { jti: payload.jti, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
    } catch {
      // An invalid or expired token means there is nothing left to revoke.
    }
  },

  async checkAvailability(params: { username?: string; email?: string }) {
    const [usernameTaken, emailTaken] = await Promise.all([
      params.username
        ? User.exists({ username: params.username.trim().toLowerCase() })
        : Promise.resolve(null),
      params.email
        ? User.exists({ email: params.email.trim().toLowerCase() })
        : Promise.resolve(null),
    ]);

    return {
      usernameAvailable: params.username ? !usernameTaken : true,
      emailAvailable: params.email ? !emailTaken : true,
    };
  },

  async issueTokens(
    user: UserDocument,
    ctx: SessionContext,
  ): Promise<TokenPair> {
    const userId = user._id.toString();
    const jti = crypto.randomUUID();

    const accessToken = signAccessToken(userId, user.username);
    const refreshToken = signRefreshToken(userId, jti);

    const ttl = durationToMs(env.jwt.refreshExpiresIn) || 30 * 86_400_000;

    await RefreshToken.create({
      user: user._id,
      jti,
      expiresAt: new Date(Date.now() + ttl),
      userAgent: ctx.userAgent ?? null,
      ip: ctx.ip ?? null,
    });

    return { accessToken, refreshToken };
  },
};

// ---------------------------------------------------------------------------
// Mongo duplicate-key helpers
// ---------------------------------------------------------------------------

interface MongoDuplicateError {
  code: number;
  keyPattern?: Record<string, unknown>;
}

function isDuplicateKeyError(error: unknown): error is MongoDuplicateError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

function duplicateKeyFields(error: MongoDuplicateError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of Object.keys(error.keyPattern ?? {})) {
    fields[key] =
      key === 'email'
        ? 'An account with this email already exists'
        : 'That username is taken';
  }
  return fields;
}
