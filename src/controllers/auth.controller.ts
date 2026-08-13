import type { Request, Response } from 'express';

import { getValidated } from '../middleware/validate.middleware.js';
import { toPublicUser } from '../models/user.model.js';
import { authService, type SessionContext } from '../services/auth.service.js';
import { ApiError } from '../utils/apiError.js';
import { sendCreated, sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type {
  AvailabilityInput,
  LoginInput,
  RefreshInput,
  SignupInput,
} from '../validators/auth.validator.js';

function contextOf(req: Request): SessionContext {
  return {
    userAgent: req.get('user-agent') ?? null,
    ip: req.ip ?? null,
  };
}

/**
 * `POST /auth/signup`
 *
 * One call creates the account *and* stores the nine onboarding answers.
 * The client buffers them locally while the user swipes through the
 * questions, so there is never a half-created user in the database.
 */
export const signup = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as SignupInput;
  const result = await authService.signup(input, contextOf(req));
  sendCreated(res, result, 'Account created');
});

/** `POST /auth/login` — accepts a username or an email as `identifier`. */
export const login = asyncHandler(async (req: Request, res: Response) => {
  const input = req.body as LoginInput;
  const result = await authService.login(input, contextOf(req));
  sendSuccess(res, result, 200, 'Signed in');
});

/** `POST /auth/refresh` — rotates the refresh token and reissues the pair. */
export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body as RefreshInput;
  const result = await authService.refresh(refreshToken, contextOf(req));
  sendSuccess(res, result);
});

/** `POST /auth/logout` — revokes this device's refresh token. */
export const logout = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken?: string };
  await authService.logout(refreshToken);
  sendSuccess(res, { loggedOut: true }, 200, 'Signed out');
});

/** `GET /auth/me` — the current user, used to revalidate a cached session. */
export const me = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  sendSuccess(res, { user: toPublicUser(req.user) });
});

/**
 * `GET /auth/check-availability?username=&email=`
 *
 * Powers the live "that username is taken" hint on the account details
 * screen. Deliberately unauthenticated and cheap.
 */
export const checkAvailability = asyncHandler(
  async (req: Request, res: Response) => {
    const params = getValidated<AvailabilityInput>(req);
    const result = await authService.checkAvailability(params);
    sendSuccess(res, result);
  },
);
