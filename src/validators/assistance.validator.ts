import { z } from 'zod';

import { PUSH_KINDS, PUSH_PLATFORMS } from '../models/deviceToken.model.js';

export const sendMessageSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Message cannot be empty')
    .max(4000, 'Message is too long'),
  /** Client-generated id that makes the send idempotent. */
  clientId: z.string().trim().min(1).max(64).optional(),
});

export const markReadSchema = z.object({
  messageId: z.string().trim().min(1, 'Which message?'),
});

export const registerDeviceSchema = z
  .object({
    token: z.string().trim().min(10, 'That does not look like a push token'),
    platform: z.enum(PUSH_PLATFORMS),
    kind: z.enum(PUSH_KINDS),
    deviceId: z.string().trim().max(128).optional(),
    appVersion: z.string().trim().max(32).optional(),
  })
  .refine(
    (v) => !(v.platform === 'android' && v.kind === 'apns_voip'),
    {
      message: 'VoIP tokens are iOS-only',
      path: ['kind'],
    },
  );

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
