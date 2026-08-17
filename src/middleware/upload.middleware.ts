import fs from 'node:fs';
import path from 'node:path';

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';

import { env } from '../config/env.js';
import { ApiError } from '../utils/apiError.js';

/** Absolute path to the uploads root, created on first use. */
export const uploadsRoot = path.resolve(process.cwd(), env.uploads.dir);
export const avatarsDir = path.join(uploadsRoot, 'avatars');

export function ensureUploadDirs(): void {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/**
 * Files are buffered in memory rather than streamed to disk so the magic
 * bytes can be inspected *before* anything is written. A client-supplied
 * MIME type is a claim, not evidence.
 */
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.uploads.maxAvatarBytes,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(
        ApiError.badRequest(
          'Only JPEG, PNG and WebP images are accepted',
          'UNSUPPORTED_MEDIA_TYPE',
          { avatar: 'Use a JPEG, PNG or WebP image' },
        ),
      );
      return;
    }
    cb(null, true);
  },
}).single('avatar');

/**
 * Wraps multer so its own errors come out in our envelope instead of a
 * raw 500 — the size limit in particular is a user-facing message.
 */
export const uploadAvatar: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  ensureUploadDirs();
  avatarUpload(req, res, (error: unknown) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(env.uploads.maxAvatarBytes / (1024 * 1024));
        return next(
          ApiError.badRequest(
            `That image is too large. Keep it under ${mb} MB.`,
            'FILE_TOO_LARGE',
            { avatar: `Maximum size is ${mb} MB` },
          ),
        );
      }
      if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(
          ApiError.badRequest(
            'Send the image in a field named "avatar"',
            'UNEXPECTED_FIELD',
          ),
        );
      }
      return next(ApiError.badRequest(error.message, 'UPLOAD_ERROR'));
    }
    return next(error);
  });
};

/**
 * Sniffs the real format from the file header. Guards against a script or
 * executable renamed to `.jpg` and sent with an image MIME type.
 */
export function detectImageExtension(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, i) => buffer[i] === byte)) return 'png';

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  return null;
}
