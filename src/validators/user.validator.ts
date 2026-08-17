import { z } from 'zod';

/**
 * Profile edits. Every field is optional — the client sends only what
 * changed — but the request must contain at least one of them, otherwise
 * it is a no-op we would rather reject than silently accept.
 */
export const updateProfileSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'That looks too short')
      .max(60, 'At most 60 characters')
      .regex(/[A-Za-z]/, 'Use letters, not just symbols')
      .optional(),

    username: z
      .string()
      .trim()
      .min(3, 'At least 3 characters')
      .max(20, 'At most 20 characters')
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9._]*$/,
        'Letters, numbers, dot and underscore only',
      )
      .refine((v) => !v.endsWith('.') && !v.endsWith('_'), {
        message: 'Cannot end with a dot or underscore',
      })
      .refine((v) => !v.includes('..') && !v.includes('__'), {
        message: 'No repeated dots or underscores',
      })
      .transform((v) => v.toLowerCase())
      .optional(),

    email: z
      .string()
      .trim()
      .email('That email does not look right')
      .transform((v) => v.toLowerCase())
      .optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
