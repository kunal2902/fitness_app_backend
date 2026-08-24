import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

/**
 * A 1:1 thread between a member and a professional.
 *
 * `participants` is stored **sorted by ObjectId** so a pair always produces
 * the same array. That is what lets a unique index guarantee one thread per
 * pair, no matter who opens it first — without it, two people tapping
 * "message" simultaneously create two threads and each sees half the
 * conversation.
 */
export interface IConversation {
  participants: mongoose.Types.ObjectId[];
  professional: mongoose.Types.ObjectId;
  member: mongoose.Types.ObjectId;

  lastMessageAt?: Date | null;
  lastMessagePreview?: string | null;
  lastMessageSender?: mongoose.Types.ObjectId | null;

  /** Unread counts keyed by user id. */
  unread: Map<string, number>;

  createdAt: Date;
  updatedAt: Date;
}

export type ConversationDocument = HydratedDocument<IConversation>;

const conversationSchema = new Schema<IConversation>(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate: {
        validator: (value: mongoose.Types.ObjectId[]) => value.length === 2,
        message: 'A conversation has exactly two participants',
      },
    },
    professional: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    member: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: null },
    lastMessageSender: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    unread: {
      type: Map,
      of: Number,
      default: () => new Map<string, number>(),
    },
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

// One thread per pair. Relies on `participants` always being sorted.
conversationSchema.index({ participants: 1 }, { unique: true });
conversationSchema.index({ member: 1, lastMessageAt: -1 });

export const Conversation: Model<IConversation> =
  (mongoose.models.Conversation as Model<IConversation> | undefined) ??
  mongoose.model<IConversation>('Conversation', conversationSchema);

/** Canonical participant ordering — always build the pair through this. */
export function sortedPair(
  a: mongoose.Types.ObjectId,
  b: mongoose.Types.ObjectId,
): mongoose.Types.ObjectId[] {
  return a.toString() < b.toString() ? [a, b] : [b, a];
}
