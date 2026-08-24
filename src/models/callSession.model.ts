import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export const CALL_STATES = [
  'ringing',
  'accepted',
  'connected',
  'ended',
] as const;
export type CallState = (typeof CALL_STATES)[number];

export const CALL_END_REASONS = [
  'completed',
  'declined',
  'cancelled',
  'missed',
  'busy',
  'failed',
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

/**
 * Server-side record of a call.
 *
 * Media never touches the server — that is peer-to-peer over WebRTC. This
 * exists so the server can decide who is allowed to signal to whom, ring
 * the callee through push, time out an unanswered call, and write the
 * "missed call" row into the chat thread afterwards.
 */
export interface ICallSession {
  /** Client-generated UUID, used as the signalling room name. */
  callId: string;

  conversation: mongoose.Types.ObjectId;
  caller: mongoose.Types.ObjectId;
  callee: mongoose.Types.ObjectId;

  withVideo: boolean;
  state: CallState;
  endReason?: CallEndReason | null;

  ringingAt: Date;
  acceptedAt?: Date | null;
  connectedAt?: Date | null;
  endedAt?: Date | null;
  durationSeconds?: number | null;

  createdAt: Date;
  updatedAt: Date;
}

export type CallSessionDocument = HydratedDocument<ICallSession>;

const callSessionSchema = new Schema<ICallSession>(
  {
    callId: { type: String, required: true, unique: true },

    conversation: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    caller: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    callee: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    withVideo: { type: Boolean, default: true },
    state: { type: String, enum: CALL_STATES, default: 'ringing' },
    endReason: { type: String, enum: CALL_END_REASONS, default: null },

    ringingAt: { type: Date, default: () => new Date() },
    acceptedAt: { type: Date, default: null },
    connectedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    durationSeconds: { type: Number, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

callSessionSchema.index({ caller: 1, createdAt: -1 });
callSessionSchema.index({ callee: 1, createdAt: -1 });
// Finding a user's live call (to reject a second incoming call as busy).
callSessionSchema.index({ state: 1, callee: 1 });

export const CallSession: Model<ICallSession> =
  (mongoose.models.CallSession as Model<ICallSession> | undefined) ??
  mongoose.model<ICallSession>('CallSession', callSessionSchema);
