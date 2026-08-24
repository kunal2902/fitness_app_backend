import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

export const MESSAGE_KINDS = ['text', 'system', 'call'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const CALL_OUTCOMES = [
  'completed',
  'missed',
  'declined',
  'cancelled',
  'failed',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export interface IMessage {
  conversation: mongoose.Types.ObjectId;
  sender: mongoose.Types.ObjectId;
  kind: MessageKind;
  body: string;

  /**
   * Client-generated id, echoed back on delivery.
   *
   * This is what makes sending idempotent: the UI shows the bubble
   * immediately with its own id, and when the server's copy arrives it
   * replaces that bubble instead of appending a duplicate. It also means a
   * retry after a dropped connection cannot double-post.
   */
  clientId?: string | null;

  /** Set on `kind: 'call'` rows so the thread shows call history inline. */
  callId?: string | null;
  callOutcome?: CallOutcome | null;
  callDurationSeconds?: number | null;
  callWithVideo?: boolean | null;

  readBy: mongoose.Types.ObjectId[];
  deliveredAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type MessageDocument = HydratedDocument<IMessage>;

const messageSchema = new Schema<IMessage>(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: MESSAGE_KINDS, default: 'text' },
    body: { type: String, required: true, maxlength: 4000 },

    clientId: { type: String, default: null },

    callId: { type: String, default: null },
    callOutcome: { type: String, enum: CALL_OUTCOMES, default: null },
    callDurationSeconds: { type: Number, default: null },
    callWithVideo: { type: Boolean, default: null },

    readBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    deliveredAt: { type: Date, default: null },
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

// History is always "this conversation, newest first".
messageSchema.index({ conversation: 1, createdAt: -1 });

// Enforces send-once per client id. Sparse + partial so the many rows with
// a null clientId (system and call entries) don't collide with each other.
messageSchema.index(
  { conversation: 1, clientId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientId: { $type: 'string' } },
  },
);

export const Message: Model<IMessage> =
  (mongoose.models.Message as Model<IMessage> | undefined) ??
  mongoose.model<IMessage>('Message', messageSchema);

/** Wire shape — mirrors `ChatMessage.fromJson` on the client. */
export interface PublicMessage {
  id: string;
  conversationId: string;
  senderId: string;
  kind: MessageKind;
  body: string;
  clientId: string | null;
  callId: string | null;
  callOutcome: CallOutcome | null;
  callDurationSeconds: number | null;
  callWithVideo: boolean | null;
  readBy: string[];
  createdAt: string;
}

export function toPublicMessage(doc: MessageDocument): PublicMessage {
  return {
    id: doc._id.toString(),
    conversationId: doc.conversation.toString(),
    senderId: doc.sender.toString(),
    kind: doc.kind,
    body: doc.body,
    clientId: doc.clientId ?? null,
    callId: doc.callId ?? null,
    callOutcome: doc.callOutcome ?? null,
    callDurationSeconds: doc.callDurationSeconds ?? null,
    callWithVideo: doc.callWithVideo ?? null,
    readBy: doc.readBy.map((id) => id.toString()),
    createdAt: doc.createdAt.toISOString(),
  };
}
