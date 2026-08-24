import type { Request, Response } from 'express';
import mongoose from 'mongoose';

import {
  CallSession,
  type CallEndReason,
} from '../models/callSession.model.js';
import { endCallAndNotify } from '../realtime/callLifecycle.js';
import { getIo } from '../realtime/socket.js';
import { callService } from '../services/call.service.js';
import { chatService } from '../services/chat.service.js';
import { professionalService } from '../services/professional.service.js';
import { pushService } from '../services/push.service.js';
import {
  buildIceServers,
  turnConfigured,
} from '../services/turn.service.js';
import { ApiError } from '../utils/apiError.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

function requireUser(req: Request): mongoose.Types.ObjectId {
  if (!req.user) throw ApiError.unauthorized();
  return req.user._id;
}

/**
 * Express 5 types a route param as `string | string[]` because a pattern
 * can match repeatedly. Ours never do, so collapse it once here rather
 * than casting at every call site.
 */
function param(req: Request, name: string): string {
  const value = req.params[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

// ---------------------------------------------------------------------------
// Professionals
// ---------------------------------------------------------------------------

/** `GET /professionals` */
export const listProfessionals = asyncHandler(
  async (_req: Request, res: Response) => {
    const professionals = await professionalService.list();
    sendSuccess(res, { professionals });
  },
);

/** `GET /professionals/:id` — full portfolio. */
export const getProfessional = asyncHandler(
  async (req: Request, res: Response) => {
    const professional = await professionalService.getById(
      param(req, 'id'),
    );
    sendSuccess(res, { professional });
  },
);

/**
 * `POST /professionals/:id/conversation`
 *
 * Opens (or returns) the thread with this coach. Called when the user taps
 * into the chat window on the detail screen.
 */
export const openConversation = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUser(req);
    const professionalUserId = await professionalService.userIdFor(
      param(req, 'id'),
    );
    const conversation = await chatService.openConversation(
      userId,
      professionalUserId,
    );

    sendSuccess(res, {
      conversation: {
        id: conversation._id.toString(),
        memberId: conversation.member.toString(),
        professionalId: conversation.professional.toString(),
        unreadCount: conversation.unread.get(userId.toString()) ?? 0,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** `GET /conversations` */
export const listConversations = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUser(req);
    const conversations = await chatService.listConversations(userId);
    sendSuccess(res, { conversations });
  },
);

/**
 * `GET /conversations/:id/messages?limit=&before=`
 *
 * `before` is an ISO timestamp, not an offset — new messages arriving at
 * the live end must not shift the page under someone scrolling back.
 */
export const getMessages = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUser(req);
  const conversation = await chatService.requireParticipant(
    param(req, 'id'),
    userId,
  );

  const rawLimit = Number(req.query.limit);
  const result = await chatService.history({
    conversationId: conversation._id,
    limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
    before: typeof req.query.before === 'string' ? req.query.before : null,
  });

  sendSuccess(res, result);
});

/**
 * `POST /conversations/:id/messages`
 *
 * The socket is the primary path; this exists so a message still sends
 * when the socket is down, and so the send is testable over plain HTTP.
 */
export const postMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUser(req);
  const conversation = await chatService.requireParticipant(
    param(req, 'id'),
    userId,
  );

  const body = (req.body ?? {}) as { body?: string; clientId?: string };
  const { message, isDuplicate } = await chatService.sendMessage({
    conversation,
    senderId: userId,
    body: body.body ?? '',
    clientId: body.clientId ?? null,
  });

  sendSuccess(res, { message, duplicate: isDuplicate }, isDuplicate ? 200 : 201);
});

/** `POST /conversations/:id/read` */
export const markConversationRead = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUser(req);
    const conversation = await chatService.requireParticipant(
      param(req, 'id'),
      userId,
    );
    const body = (req.body ?? {}) as { messageId?: string };
    const { readAt } = await chatService.markRead(
      conversation,
      userId,
      body.messageId ?? '',
    );
    sendSuccess(res, { readAt: readAt.toISOString() });
  },
);

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * `GET /calls/ice-servers`
 *
 * Fetched right before dialling. Credentials are short-lived, so they are
 * requested per call rather than cached at login.
 */
export const getIceServers = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUser(req);
    sendSuccess(res, {
      iceServers: buildIceServers(userId.toString()),
      turnAvailable: turnConfigured(),
    });
  },
);

/** `GET /calls/history?limit=` */
export const getCallHistory = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUser(req);
    const rawLimit = Number(req.query.limit);
    const limit = Math.min(
      Math.max(Number.isFinite(rawLimit) ? rawLimit : 30, 1),
      100,
    );

    const calls = await CallSession.find({
      $or: [{ caller: userId }, { callee: userId }],
    })
      .sort({ createdAt: -1 })
      .limit(limit);

    sendSuccess(res, {
      calls: calls.map((call) => ({
        callId: call.callId,
        conversationId: call.conversation.toString(),
        direction: call.caller.equals(userId) ? 'outgoing' : 'incoming',
        withVideo: call.withVideo,
        state: call.state,
        endReason: call.endReason,
        durationSeconds: call.durationSeconds ?? 0,
        createdAt: call.createdAt.toISOString(),
      })),
    });
  },
);

/**
 * `POST /calls/:callId/end`
 *
 * Escape hatch for when the socket died mid-call — without it the call
 * would sit "connected" until the sweeper gave up on it.
 */
export const endCall = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUser(req);
  const call = await callService.requireParticipant(
    param(req, 'callId'),
    userId,
  );

  // This runs the SAME path as the socket handler, deliberately. An
  // earlier version only marked the session ended: the peer's UI stayed
  // on a live call screen until ICE gave up ~20s later, and the call
  // never appeared in either history. The whole point of this endpoint is
  // that the socket is down — the *other* person's socket usually is not.
  const reason =
    typeof req.body?.reason === 'string' &&
    ['cancelled', 'completed', 'failed', 'missed', 'declined', 'busy'].includes(
      req.body.reason as string,
    )
      ? (req.body.reason as CallEndReason)
      : call.state === 'ringing'
        ? 'cancelled'
        : 'completed';

  await endCallAndNotify(getIo(), call, reason);
  sendSuccess(res, { ended: true });
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** `POST /devices` — register a push token. */
export const registerDevice = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireUser(req);
    const body = req.body as {
      token: string;
      platform: 'android' | 'ios';
      kind: 'fcm' | 'apns_voip';
      deviceId?: string;
      appVersion?: string;
    };

    await pushService.registerDevice({
      userId: userId.toString(),
      token: body.token,
      platform: body.platform,
      kind: body.kind,
      deviceId: body.deviceId ?? null,
      appVersion: body.appVersion ?? null,
    });

    sendSuccess(res, { registered: true }, 201);
  },
);

/** `DELETE /devices/:token` — called on sign-out. */
export const unregisterDevice = asyncHandler(
  async (req: Request, res: Response) => {
    requireUser(req);
    await pushService.unregisterDevice(param(req, 'token'));
    sendSuccess(res, { unregistered: true });
  },
);
