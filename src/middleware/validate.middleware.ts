import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';

import { ApiError } from '../utils/apiError.js';

type Source = 'body' | 'query' | 'params';

/**
 * Parses the chosen part of the request with a Zod schema and replaces it
 * with the parsed (and coerced) result, so controllers receive typed data.
 *
 * A failure becomes a 422 with per-field messages, which the Flutter form
 * maps straight onto its inputs.
 */
export function validate(schema: ZodTypeAny, source: Source = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req[source]);

      if (source === 'body') {
        req.body = parsed;
      } else {
        // req.query and req.params have read-only getters in Express 5 —
        // stash the parsed copy instead of assigning over them.
        (req as Request & { validated?: unknown }).validated = parsed;
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of error.issues) {
          const key = leafFieldName(issue.path) || source;
          if (!fieldErrors[key]) fieldErrors[key] = issue.message;
        }
        next(ApiError.validation(fieldErrors));
        return;
      }
      next(error);
    }
  };
}

/** Reads whatever `validate(..., 'query')` stashed. */
export function getValidated<T>(req: Request): T {
  return (req as Request & { validated?: T }).validated as T;
}

/**
 * Reduces a Zod issue path to the field name a form can highlight:
 * `['fitnessProfile', 'heightCm'] → 'heightCm'`, and
 * `['fitnessProfile', 'goals', 2] → 'goals'`.
 *
 * Mongoose validation errors are keyed the same way in
 * `error.middleware.ts`, so the client sees one shape whichever layer
 * rejected the request.
 */
function leafFieldName(path: ReadonlyArray<string | number | symbol>): string {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const segment = path[i];
    if (typeof segment === 'string') return segment;
  }
  return '';
}
