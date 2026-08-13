import type { NextFunction, Request, Response } from 'express';

import { User } from '../models/user.model.js';
import { ApiError } from '../utils/apiError.js';
import { verifyAccessToken } from '../utils/jwt.js';

/**
 * Verifies the `Authorization: Bearer <token>` header and attaches the
 * user to the request. Anything that needs a signed-in user goes through
 * this — never trust a user id from the body or query string.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw ApiError.unauthorized('Missing access token', 'NO_TOKEN');
    }

    const token = header.slice('Bearer '.length).trim();
    const payload = verifyAccessToken(token);

    const user = await User.findById(payload.sub);
    if (!user) {
      throw ApiError.unauthorized('Account no longer exists', 'USER_GONE');
    }

    req.user = user;
    req.userId = user._id.toString();
    next();
  } catch (error) {
    next(error);
  }
}

/** Attaches the user when a token is present, but never rejects. */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();

  try {
    const payload = verifyAccessToken(header.slice('Bearer '.length).trim());
    const user = await User.findById(payload.sub);
    if (user) {
      req.user = user;
      req.userId = user._id.toString();
    }
  } catch {
    // Ignore — the route works fine unauthenticated.
  }
  next();
}
