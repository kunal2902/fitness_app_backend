import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';

import { env } from '../config/env.js';
import { ApiError } from '../utils/apiError.js';

/** 404 for anything that fell through the router. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(ApiError.notFound(`No route for ${req.method} ${req.originalUrl}`));
}

/**
 * The single place errors turn into JSON. Every response shape here is
 * something `ApiException` in the Flutter client knows how to read.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let status = 500;
  let message = 'Something went wrong';
  let code = 'INTERNAL_ERROR';
  let fieldErrors: Record<string, string> = {};

  if (error instanceof ApiError) {
    status = error.statusCode;
    message = error.message;
    code = error.code;
    fieldErrors = error.fieldErrors;
  } else if (error instanceof mongoose.Error.ValidationError) {
    status = 422;
    message = 'Please check the highlighted fields';
    code = 'VALIDATION_ERROR';
    for (const [path, detail] of Object.entries(error.errors)) {
      // Report `fitnessProfile.goals` as `goals` so the client can match it.
      fieldErrors[path.split('.').pop() ?? path] = detail.message;
    }
  } else if (error instanceof mongoose.Error.CastError) {
    status = 400;
    message = 'That identifier is not valid';
    code = 'INVALID_ID';
  } else if (isDuplicateKey(error)) {
    status = 409;
    message = 'Those details are already in use';
    code = 'DUPLICATE_KEY';
    for (const key of Object.keys(error.keyPattern ?? {})) {
      fieldErrors[key] = 'Already taken';
    }
  } else if (error instanceof SyntaxError && 'body' in error) {
    status = 400;
    message = 'Malformed JSON body';
    code = 'BAD_JSON';
  }

  if (status >= 500) {
    console.error('[error]', error);
  }

  res.status(status).json({
    success: false,
    message,
    code,
    ...(Object.keys(fieldErrors).length > 0 ? { errors: fieldErrors } : {}),
    ...(env.isProduction
      ? {}
      : { stack: error instanceof Error ? error.stack : undefined }),
  });
}

function isDuplicateKey(
  error: unknown,
): error is { code: number; keyPattern?: Record<string, unknown> } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}
