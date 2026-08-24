import mongoose, { type QueryFilter } from 'mongoose';

import {
  Conversation,
  sortedPair,
  type ConversationDocument,
} from '../models/conversation.model.js';
import {
  Message,
  toPublicMessage,
  type IMessage,
  type MessageDocument,
  type PublicMessage,
} from '../models/message.model.js';
import { Professional } from '../models/professional.model.js';
import { User } from '../models/user.model.js';
import { ApiError } from '../utils/apiError.js';

export interface ConversationSummary {
  id: string;
  memberId: string;
  professionalId: string;
  professionalProfileId: string | null;
  otherParty: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  };
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
}

export const chatService = {
  /**
   * Finds the thread between these two, creating it on first contact.
   *
   * The unique index on the sorted participant pair is what makes this
   * safe under a race: if two requests create the same thread at once, one
   * loses on the index and we simply read the winner's row back.
   */
  async openConversation(
    memberId: mongoose.Types.ObjectId,
    professionalUserId: mongoose.Types.ObjectId,
  ): Promise<ConversationDocument> {
    if (memberId.equals(professionalUserId)) {
      throw ApiError.badRequest(
        'You cannot start a conversation with yourself',
        'SELF_CONVERSATION',
      );
    }

    const professionalUser = await User.findById(professionalUserId);
    if (!professionalUser || professionalUser.role !== 'professional') {
      throw ApiError.notFound('That professional does not exist', 'NO_PRO');
    }

    const participants = sortedPair(memberId, professionalUserId);

    const existing = await Conversation.findOne({ participants });
    if (existing) return existing;

    try {
      return await Conversation.create({
        participants,
        member: memberId,
        professional: professionalUserId,
        unread: new Map<string, number>(),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const raced = await Conversation.findOne({ participants });
        if (raced) return raced;
      }
      throw error;
    }
  },

  async requireParticipant(
    conversationId: string,
    userId: mongoose.Types.ObjectId,
  ): Promise<ConversationDocument> {
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      throw ApiError.notFound('Conversation not found', 'NO_CONVERSATION');
    }

    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      throw ApiError.notFound('Conversation not found', 'NO_CONVERSATION');
    }

    const isParticipant = conversation.participants.some((id) =>
      id.equals(userId),
    );
    if (!isParticipant) {
      // 404 rather than 403: a stranger should not be able to confirm that
      // a given conversation id exists at all.
      throw ApiError.notFound('Conversation not found', 'NO_CONVERSATION');
    }

    return conversation;
  },

  /**
   * Persists a message and bumps the thread.
   *
   * Idempotent on `(conversation, clientId)`: a retry after a dropped
   * socket returns the message already stored rather than posting twice.
   */
  async sendMessage(params: {
    conversation: ConversationDocument;
    senderId: mongoose.Types.ObjectId;
    body: string;
    clientId?: string | null;
    kind?: 'text' | 'system' | 'call';
    callId?: string | null;
    callOutcome?: MessageDocument['callOutcome'];
    callDurationSeconds?: number | null;
    callWithVideo?: boolean | null;
  }): Promise<{ message: PublicMessage; isDuplicate: boolean }> {
    const {
      conversation,
      senderId,
      body,
      clientId = null,
      kind = 'text',
    } = params;

    const trimmed = body.trim();
    if (kind === 'text' && trimmed.length === 0) {
      throw ApiError.badRequest('Message cannot be empty', 'EMPTY_MESSAGE');
    }
    if (trimmed.length > 4000) {
      throw ApiError.badRequest('Message is too long', 'MESSAGE_TOO_LONG');
    }

    if (clientId) {
      const existing = await Message.findOne({
        conversation: conversation._id,
        clientId,
      });
      if (existing) {
        return { message: toPublicMessage(existing), isDuplicate: true };
      }
    }

    let doc: MessageDocument;
    try {
      doc = await Message.create({
        conversation: conversation._id,
        sender: senderId,
        kind,
        body: trimmed,
        clientId,
        callId: params.callId ?? null,
        callOutcome: params.callOutcome ?? null,
        callDurationSeconds: params.callDurationSeconds ?? null,
        callWithVideo: params.callWithVideo ?? null,
        readBy: [senderId],
        deliveredAt: new Date(),
      });
    } catch (error) {
      // Lost the race on the idempotency index — the other write won.
      if (isDuplicateKeyError(error) && clientId) {
        const raced = await Message.findOne({
          conversation: conversation._id,
          clientId,
        });
        if (raced) return { message: toPublicMessage(raced), isDuplicate: true };
      }
      throw error;
    }

    // Bump the thread and increment unread for everyone except the sender.
    conversation.lastMessageAt = doc.createdAt;
    conversation.lastMessagePreview = previewOf(doc);
    conversation.lastMessageSender = senderId;
    for (const participant of conversation.participants) {
      if (participant.equals(senderId)) continue;
      const key = participant.toString();
      conversation.unread.set(key, (conversation.unread.get(key) ?? 0) + 1);
    }
    await conversation.save();

    return { message: toPublicMessage(doc), isDuplicate: false };
  },

  /**
   * Newest-first page of history.
   *
   * Cursor is the `createdAt` of the oldest message already held, which
   * keeps paging stable while new messages arrive at the other end — an
   * offset would shift under the reader and duplicate rows.
   */
  async history(params: {
    conversationId: mongoose.Types.ObjectId;
    limit?: number;
    before?: string | null;
  }): Promise<{ messages: PublicMessage[]; hasMore: boolean }> {
    const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);

    // Mongoose 9 renamed FilterQuery to QueryFilter, and it takes the raw
    // document type rather than the hydrated one.
    const query: QueryFilter<IMessage> = {
      conversation: params.conversationId,
    };
    if (params.before) {
      const cursor = new Date(params.before);
      if (!Number.isNaN(cursor.getTime())) {
        query.createdAt = { $lt: cursor };
      }
    }

    // Fetch one extra to detect a further page without a second count.
    const docs = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1);

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    return {
      // Oldest-first is what a chat list wants to render.
      messages: page.reverse().map(toPublicMessage),
      hasMore,
    };
  },

  async markRead(
    conversation: ConversationDocument,
    userId: mongoose.Types.ObjectId,
    upToMessageId: string,
  ): Promise<{ readAt: Date }> {
    const target = mongoose.Types.ObjectId.isValid(upToMessageId)
      ? await Message.findById(upToMessageId)
      : null;

    const cutoff = target?.createdAt ?? new Date();

    await Message.updateMany(
      {
        conversation: conversation._id,
        createdAt: { $lte: cutoff },
        sender: { $ne: userId },
        readBy: { $ne: userId },
      },
      { $addToSet: { readBy: userId } },
    );

    conversation.unread.set(userId.toString(), 0);
    await conversation.save();

    return { readAt: cutoff };
  },

  async listConversations(
    userId: mongoose.Types.ObjectId,
  ): Promise<ConversationSummary[]> {
    const conversations = await Conversation.find({ participants: userId })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(50);

    if (conversations.length === 0) return [];

    // Resolve the other party for every thread in two queries rather than
    // two per thread.
    const otherIds = conversations.map((c) =>
      c.participants.find((p) => !p.equals(userId)) ?? c.professional,
    );

    const [users, professionals] = await Promise.all([
      User.find({ _id: { $in: otherIds } }),
      Professional.find({ user: { $in: otherIds } }),
    ]);

    const userById = new Map(users.map((u) => [u._id.toString(), u]));
    const proByUser = new Map(
      professionals.map((p) => [p.user.toString(), p]),
    );

    return conversations.map((c) => {
      const otherId = (
        c.participants.find((p) => !p.equals(userId)) ?? c.professional
      ).toString();
      const other = userById.get(otherId);
      const pro = proByUser.get(otherId);

      return {
        id: c._id.toString(),
        memberId: c.member.toString(),
        professionalId: c.professional.toString(),
        professionalProfileId: pro?._id.toString() ?? null,
        otherParty: {
          id: otherId,
          displayName: pro?.displayName ?? other?.fullName ?? 'Unknown',
          avatarUrl: pro?.avatarUrl ?? other?.avatarUrl ?? null,
        },
        lastMessagePreview: c.lastMessagePreview ?? null,
        lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        unreadCount: c.unread.get(userId.toString()) ?? 0,
      };
    });
  },
};

function previewOf(doc: MessageDocument): string {
  if (doc.kind === 'call') {
    return doc.callWithVideo === false ? 'Voice call' : 'Video call';
  }
  return doc.body.slice(0, 140);
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}
