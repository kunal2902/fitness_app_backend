import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';

import { env } from '../config/env.js';
import { ApiError } from './apiError.js';

export interface AccessTokenPayload extends JwtPayload {
  sub: string;
  username: string;
  type: 'access';
}

export interface RefreshTokenPayload extends JwtPayload {
  sub: string;
  /** Rotated on every refresh so a stolen token dies on next use. */
  jti: string;
  type: 'refresh';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// @types/jsonwebtoken types `expiresIn` as a template-literal union; our
// values come from env as plain strings, so widen once here.
type ExpiresIn = SignOptions['expiresIn'];

export function signAccessToken(userId: string, username: string): string {
  return jwt.sign(
    { username, type: 'access' },
    env.jwt.accessSecret,
    {
      subject: userId,
      issuer: env.jwt.issuer,
      expiresIn: env.jwt.accessExpiresIn as ExpiresIn,
    },
  );
}

export function signRefreshToken(userId: string, jti: string): string {
  return jwt.sign(
    { type: 'refresh' },
    env.jwt.refreshSecret,
    {
      subject: userId,
      jwtid: jti,
      issuer: env.jwt.issuer,
      expiresIn: env.jwt.refreshExpiresIn as ExpiresIn,
    },
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwt.accessSecret, {
      issuer: env.jwt.issuer,
    });
    if (typeof decoded === 'string' || decoded.type !== 'access') {
      throw ApiError.unauthorized('Invalid token', 'INVALID_TOKEN');
    }
    return decoded as AccessTokenPayload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized('Access token expired', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid token', 'INVALID_TOKEN');
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    const decoded = jwt.verify(token, env.jwt.refreshSecret, {
      issuer: env.jwt.issuer,
    });
    if (typeof decoded === 'string' || decoded.type !== 'refresh') {
      throw ApiError.unauthorized('Invalid refresh token', 'INVALID_REFRESH');
    }
    return decoded as RefreshTokenPayload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized(
        'Session expired. Please sign in again.',
        'REFRESH_EXPIRED',
      );
    }
    throw ApiError.unauthorized('Invalid refresh token', 'INVALID_REFRESH');
  }
}

/** Milliseconds until a `30d` / `15m` style duration elapses. */
export function durationToMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration.trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * (multipliers[unit as string] ?? 0);
}
