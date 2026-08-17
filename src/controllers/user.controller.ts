import type { Request, Response } from 'express';

import { toPublicUser } from '../models/user.model.js';
import { userService } from '../services/user.service.js';
import { ApiError } from '../utils/apiError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { UpdateProfileInput } from '../validators/user.validator.js';

/** `GET /users/me` */
export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  sendSuccess(res, { user: toPublicUser(req.user) });
});

/**
 * `PATCH /users/me`
 *
 * Partial update — send only the fields that changed. Changing the email
 * resets `isEmailVerified`.
 */
export const updateProfile = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const input = req.body as UpdateProfileInput;
    const user = await userService.updateProfile(req.user, input);
    sendSuccess(res, { user }, 200, 'Profile updated');
  },
);

/**
 * `POST /users/me/avatar` — multipart, field name `avatar`.
 */
export const uploadAvatarImage = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    if (!req.file) {
      throw ApiError.badRequest(
        'No image was attached',
        'NO_FILE',
        { avatar: 'Choose an image first' },
      );
    }
    const user = await userService.setAvatar(req.user, req.file);
    sendSuccess(res, { user }, 200, 'Profile picture updated');
  },
);

/** `DELETE /users/me/avatar` — falls back to the initials monogram. */
export const deleteAvatarImage = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const user = await userService.removeAvatar(req.user);
    sendSuccess(res, { user }, 200, 'Profile picture removed');
  },
);
