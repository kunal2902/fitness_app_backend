import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../config/env.js';
import {
  avatarsDir,
  detectImageExtension,
  ensureUploadDirs,
} from '../middleware/upload.middleware.js';
import {
  User,
  toPublicUser,
  type PublicUser,
  type UserDocument,
} from '../models/user.model.js';
import { ApiError } from '../utils/apiError.js';
import type { UpdateProfileInput } from '../validators/user.validator.js';

export const userService = {
  /**
   * Applies a partial profile update.
   *
   * Username and email are unique, so each is checked against every *other*
   * user before writing. Changing an email clears `isEmailVerified` — the
   * new address has not been proven yet.
   */
  async updateProfile(
    user: UserDocument,
    input: UpdateProfileInput,
  ): Promise<PublicUser> {
    const conflicts: Record<string, string> = {};

    if (input.username && input.username !== user.username) {
      const taken = await User.exists({
        username: input.username,
        _id: { $ne: user._id },
      });
      if (taken) conflicts.username = 'That username is taken';
    }

    if (input.email && input.email !== user.email) {
      const taken = await User.exists({
        email: input.email,
        _id: { $ne: user._id },
      });
      if (taken) conflicts.email = 'An account with this email already exists';
    }

    if (Object.keys(conflicts).length > 0) {
      throw ApiError.conflict(
        'Those details are already in use',
        'CREDENTIALS_TAKEN',
        conflicts,
      );
    }

    if (input.fullName !== undefined) user.fullName = input.fullName;
    if (input.username !== undefined) user.username = input.username;
    if (input.email !== undefined && input.email !== user.email) {
      user.email = input.email;
      user.isEmailVerified = false;
    }

    try {
      await user.save();
    } catch (error) {
      // The unique index is the real guard against a concurrent claim.
      if (isDuplicateKeyError(error)) {
        throw ApiError.conflict(
          'Those details are already in use',
          'CREDENTIALS_TAKEN',
          duplicateKeyFields(error),
        );
      }
      throw error;
    }

    return toPublicUser(user);
  },

  /**
   * Writes the uploaded image to disk and points the user at it.
   *
   * The extension comes from the file's magic bytes, never from the
   * client-supplied filename, and the stored name is random — an attacker
   * cannot choose where the file lands or what it is called.
   */
  async setAvatar(
    user: UserDocument,
    file: { buffer: Buffer; mimetype: string },
  ): Promise<PublicUser> {
    const extension = detectImageExtension(file.buffer);
    if (!extension) {
      throw ApiError.badRequest(
        'That file is not a valid JPEG, PNG or WebP image',
        'INVALID_IMAGE',
        { avatar: 'Choose a valid image file' },
      );
    }

    ensureUploadDirs();

    const filename = `${user._id.toString()}-${crypto
      .randomBytes(8)
      .toString('hex')}.${extension}`;

    await fs.writeFile(path.join(avatarsDir, filename), file.buffer);

    const previous = user.avatarUrl;
    user.avatarUrl = `${env.uploads.publicPath}/avatars/${filename}`;
    await user.save({ validateBeforeSave: false });

    // Only after the new one is safely committed.
    await removeAvatarFile(previous);

    return toPublicUser(user);
  },

  async removeAvatar(user: UserDocument): Promise<PublicUser> {
    const previous = user.avatarUrl;
    user.avatarUrl = null;
    await user.save({ validateBeforeSave: false });
    await removeAvatarFile(previous);
    return toPublicUser(user);
  },
};

/**
 * Deletes a stored avatar, refusing anything that resolves outside the
 * avatars directory — the stored path is ours, but treating it as
 * untrusted costs nothing and closes a path-traversal hole permanently.
 */
async function removeAvatarFile(storedPath?: string | null): Promise<void> {
  if (!storedPath) return;

  const prefix = `${env.uploads.publicPath}/avatars/`;
  if (!storedPath.startsWith(prefix)) return;

  const filename = storedPath.slice(prefix.length);
  const target = path.resolve(avatarsDir, filename);
  if (path.dirname(target) !== path.resolve(avatarsDir)) return;

  try {
    await fs.unlink(target);
  } catch {
    // Already gone, or never written — nothing to clean up.
  }
}

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
