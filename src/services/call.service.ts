import mongoose from 'mongoose';

import { env } from '../config/env.js';
import {
  CallSession,
  type CallEndReason,
  type CallSessionDocument,
} from '../models/callSession.model.js';
import type { ConversationDocument } from '../models/conversation.model.js';
import { ApiError } from '../utils/apiError.js';
import { chatService } from './chat.service.js';

/**
 * Call lifecycle, independent of transport.
 *
 * The server never sees media — that is peer-to-peer. What it owns is the
 * *state machine*: who may signal to whom, when a call has rung too long,
 * and what gets written into the chat thread afterwards.
 */
export const callService = {
  /** A user already on a call cannot be rung by someone else. */
  async activeCallFor(
    userId: mongoose.Types.ObjectId,
  ): Promise<CallSessionDocument | null> {
    return CallSession.findOne({
      state: { $in: ['ringing', 'accepted', 'connected'] },
      $or: [{ caller: userId }, { callee: userId }],
    });
  },

  async create(params: {
    callId: string;
    conversation: ConversationDocument;
    callerId: mongoose.Types.ObjectId;
    withVideo: boolean;
  }): Promise<CallSessionDocument> {
    const callee = params.conversation.participants.find(
      (id) => !id.equals(params.callerId),
    );
    if (!callee) {
      throw ApiError.badRequest('No one to call', 'NO_CALLEE');
    }

    // The client supplies callId so it can wire its peer connection before
    // the round trip; a collision means a repeat or a spoof, so reject it.
    const existing = await CallSession.findOne({ callId: params.callId });
    if (existing) {
      throw ApiError.conflict('That call already exists', 'CALL_EXISTS');
    }

    return CallSession.create({
      callId: params.callId,
      conversation: params.conversation._id,
      caller: params.callerId,
      callee,
      withVideo: params.withVideo,
      state: 'ringing',
      ringingAt: new Date(),
    });
  },

  async find(callId: string): Promise<CallSessionDocument | null> {
    return CallSession.findOne({ callId });
  },

  /**
   * Loads a call and asserts the caller is one of its two participants.
   *
   * Every signalling event goes through this. Without it, knowing a callId
   * would be enough to inject SDP into someone else's call.
   */
  async requireParticipant(
    callId: string,
    userId: mongoose.Types.ObjectId,
  ): Promise<CallSessionDocument> {
    const call = await CallSession.findOne({ callId });
    if (!call) throw ApiError.notFound('Call not found', 'NO_CALL');

    if (!call.caller.equals(userId) && !call.callee.equals(userId)) {
      throw ApiError.notFound('Call not found', 'NO_CALL');
    }
    return call;
  },

  /**
   * Claims a ringing call, atomically.
   *
   * Returns null when someone else got there first. A conditional update
   * rather than read-then-write because the race is real: a phone and a
   * tablet ringing together, both answered inside one round trip. With a
   * read-then-write both accepts "succeed", each tells the other device
   * `answered_elsewhere`, and both hang up — the caller is left connecting
   * to nobody.
   */
  async claimForAccept(
    call: CallSessionDocument,
  ): Promise<CallSessionDocument | null> {
    return CallSession.findOneAndUpdate(
      { callId: call.callId, state: 'ringing' },
      { $set: { state: 'accepted', acceptedAt: new Date() } },
      { new: true },
    );
  },

  async markConnected(call: CallSessionDocument): Promise<CallSessionDocument> {
    if (call.state === 'ended') return call;
    call.state = 'connected';
    call.connectedAt ??= new Date();
    await call.save();
    return call;
  },

  /**
   * Terminal transition. Idempotent — both peers usually report the end,
   * and a hangup racing a timeout must not produce two chat entries.
   */
  async end(
    call: CallSessionDocument,
    reason: CallEndReason,
  ): Promise<{ call: CallSessionDocument; alreadyEnded: boolean }> {
    if (call.state === 'ended') {
      return { call, alreadyEnded: true };
    }

    const endedAt = new Date();
    const startedAt = call.connectedAt ?? call.acceptedAt;
    const durationSeconds = startedAt
      ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))
      : 0;

    // Conditional update, not read-then-save. The in-memory check above is
    // only an early out — it cannot serialise two handlers that both read
    // a live call before either writes. That is not exotic: a double-tap
    // on hang-up sends two `call:end` events (the bloc's default
    // transformer is concurrent), and both peers now arm a connect
    // watchdog that fires within milliseconds of each other. Two winners
    // means two "Video call · 3m 12s" rows in the thread and two teardown
    // broadcasts.
    const updated = await CallSession.findOneAndUpdate(
      { callId: call.callId, state: { $ne: 'ended' } },
      {
        $set: {
          state: 'ended',
          endReason: reason,
          endedAt,
          durationSeconds,
        },
      },
      { new: true },
    );

    if (!updated) return { call, alreadyEnded: true };
    return { call: updated, alreadyEnded: false };
  },

  /**
   * Writes the call into the chat thread so history reads as one timeline
   * rather than messages here and calls somewhere else.
   */
  async appendCallMessage(
    call: CallSessionDocument,
    conversation: ConversationDocument,
  ): Promise<void> {
    const outcome = outcomeFor(call.endReason ?? 'failed');

    await chatService.sendMessage({
      conversation,
      // Attributed to the caller: "you called" / "they called".
      senderId: call.caller,
      // Idempotency key. One call is one row, whatever races to write it —
      // the partial unique index on {conversation, clientId} makes a
      // second attempt a no-op instead of a duplicate entry in the thread.
      clientId: `call:${call.callId}`,
      kind: 'call',
      body: describe(call.withVideo, outcome, call.durationSeconds ?? 0),
      callId: call.callId,
      callOutcome: outcome,
      callDurationSeconds: call.durationSeconds ?? 0,
      callWithVideo: call.withVideo,
    });
  },

  /** Calls still ringing past the timeout, for the sweeper to clean up. */
  async expiredRingingCalls(): Promise<CallSessionDocument[]> {
    const cutoff = new Date(
      Date.now() - env.realtime.ringTimeoutSeconds * 1000,
    );
    return CallSession.find({ state: 'ringing', ringingAt: { $lt: cutoff } });
  },

  /**
   * Calls stuck in `accepted` or `connected` long past any plausible
   * conversation.
   *
   * This is the safety net under every way a client can die without
   * saying goodbye — a crash, a force-quit, an ICE failure on both ends
   * at once. Nothing else clears those rows, and while one exists
   * [activeCallFor] reports BOTH participants as busy, so every future
   * call between them is refused with "They are on another call right
   * now." forever. There is no way out of that from inside the app.
   *
   * The bound is deliberately generous — hours, not minutes — because
   * ending a call somebody is still on is far worse than leaving a dead
   * row around for a while. The socket-disconnect path handles the common
   * case within seconds; this catches what it misses.
   */
  async stalledCalls(): Promise<CallSessionDocument[]> {
    const cutoff = new Date(Date.now() - env.realtime.maxCallSeconds * 1000);
    return CallSession.find({
      state: { $in: ['accepted', 'connected'] },
      $or: [
        { connectedAt: { $lt: cutoff } },
        // `connectedAt: null`, NOT `$exists: false`. The schema declares
        // `default: null`, so the field is written as an explicit null on
        // every insert and `$exists` is always true — and `$lt` against a
        // Date is type-bracketed, so it never matches null either. With
        // `$exists: false` this branch could not match anything, which
        // left exactly the calls this reaper exists for — accepted but
        // never connected — leaking forever. `{field: null}` matches both
        // missing and explicit null.
        { connectedAt: null, acceptedAt: { $lt: cutoff } },
      ],
    });
  },

  /** Live calls a given user is part of — used when their socket drops. */
  async activeCallsForUser(
    userId: mongoose.Types.ObjectId,
  ): Promise<CallSessionDocument[]> {
    return CallSession.find({
      state: { $in: ['ringing', 'accepted', 'connected'] },
      $or: [{ caller: userId }, { callee: userId }],
    });
  },
};

function outcomeFor(reason: CallEndReason) {
  switch (reason) {
    case 'completed':
      return 'completed' as const;
    case 'declined':
      return 'declined' as const;
    case 'cancelled':
      return 'cancelled' as const;
    case 'missed':
      return 'missed' as const;
    case 'busy':
      return 'declined' as const;
    default:
      return 'failed' as const;
  }
}

function describe(
  withVideo: boolean,
  outcome: ReturnType<typeof outcomeFor>,
  seconds: number,
): string {
  const kind = withVideo ? 'Video call' : 'Voice call';
  switch (outcome) {
    case 'completed':
      return `${kind} · ${formatDuration(seconds)}`;
    case 'missed':
      return `Missed ${kind.toLowerCase()}`;
    case 'declined':
      return `${kind} declined`;
    case 'cancelled':
      return `${kind} cancelled`;
    default:
      return `${kind} failed`;
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
