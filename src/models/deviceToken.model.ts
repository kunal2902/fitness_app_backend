import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export const PUSH_PLATFORMS = ['android', 'ios'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export const PUSH_KINDS = ['fcm', 'apns_voip'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/**
 * A device that can be rung.
 *
 * iOS needs **two** tokens per device and they are not interchangeable: an
 * FCM token for ordinary notifications, and a separate PushKit VoIP token
 * that is the only thing allowed to trigger CallKit. Android rings from a
 * high-priority FCM data message, so one token covers both cases there.
 */
export interface IDeviceToken {
  user: mongoose.Types.ObjectId;
  token: string;
  platform: PushPlatform;
  kind: PushKind;
  deviceId?: string | null;
  appVersion?: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type DeviceTokenDocument = HydratedDocument<IDeviceToken>;

const deviceTokenSchema = new Schema<IDeviceToken>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    token: { type: String, required: true },
    platform: { type: String, enum: PUSH_PLATFORMS, required: true },
    kind: { type: String, enum: PUSH_KINDS, required: true },
    deviceId: { type: String, default: null },
    appVersion: { type: String, default: null },
    lastSeenAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

// A token identifies exactly one install, and it can move between accounts
// when two people share a phone — so the token alone is the key.
deviceTokenSchema.index({ token: 1 }, { unique: true });

export const DeviceToken: Model<IDeviceToken> =
  (mongoose.models.DeviceToken as Model<IDeviceToken> | undefined) ??
  mongoose.model<IDeviceToken>('DeviceToken', deviceTokenSchema);
