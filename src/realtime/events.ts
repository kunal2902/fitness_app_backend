/**
 * Every socket event name and payload, in one file.
 *
 * These strings are a wire contract with `lib/config/socket_events.dart`.
 * A typo on one side fails silently — the event simply never arrives — so
 * both sides read from a constants table rather than inline literals.
 */

export const SocketEvents = {
  // --- connection lifecycle ---
  connected: 'connected',
  error: 'app:error',

  // --- presence ---
  presenceSubscribe: 'presence:subscribe',
  presenceUnsubscribe: 'presence:unsubscribe',
  presenceUpdate: 'presence:update',
  presenceSnapshot: 'presence:snapshot',

  // --- chat ---
  chatJoin: 'chat:join',
  chatLeave: 'chat:leave',
  chatSend: 'chat:send',
  chatMessage: 'chat:message',
  chatDelivered: 'chat:delivered',
  chatTyping: 'chat:typing',
  chatRead: 'chat:read',

  // --- calls: control plane ---
  callInvite: 'call:invite',
  callIncoming: 'call:incoming',
  callAccept: 'call:accept',
  callAccepted: 'call:accepted',
  callReject: 'call:reject',
  callRejected: 'call:rejected',
  callCancel: 'call:cancel',
  callCancelled: 'call:cancelled',
  callEnd: 'call:end',
  callEnded: 'call:ended',
  callBusy: 'call:busy',

  // --- calls: WebRTC signalling (relayed verbatim, never inspected) ---
  callOffer: 'call:offer',
  callAnswer: 'call:answer',
  callIce: 'call:ice',
} as const;

export type SocketEventName = (typeof SocketEvents)[keyof typeof SocketEvents];

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface ChatSendPayload {
  conversationId: string;
  body: string;
  /** Client-generated, echoed back so the optimistic bubble can reconcile. */
  clientId: string;
}

export interface ChatTypingPayload {
  conversationId: string;
  isTyping: boolean;
}

export interface ChatReadPayload {
  conversationId: string;
  /** Everything up to and including this message is read. */
  messageId: string;
}

export interface CallInvitePayload {
  conversationId: string;
  /** Client-generated UUID; becomes the signalling room name. */
  callId: string;
  withVideo: boolean;
}

export interface CallIdPayload {
  callId: string;
}

export interface CallRejectPayload extends CallIdPayload {
  /**
   * 'missed' is sent by the callee's own ring timeout — the phone gave up
   * before anyone touched it. It has to survive as its own reason or the
   * chat thread reads "Video call declined" for a call the user never saw,
   * which is a materially different (and unfair) thing to tell a coach.
   */
  reason?: 'declined' | 'busy' | 'missed';
}

/**
 * SDP and ICE bodies are opaque to the server — it checks only that the
 * sender is a participant in that call, then relays. Parsing SDP
 * server-side would buy nothing and break the moment a codec changes.
 */
export interface CallSdpPayload extends CallIdPayload {
  sdp: { type: string; sdp: string };
}

export interface CallIcePayload extends CallIdPayload {
  candidate: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  };
}

export interface PresencePayload {
  userIds: string[];
}

/** A user's room. Every device the user has joins it, so an event
 *  addressed to a user reaches all their sessions. */
export const userRoom = (userId: string): string => `user:${userId}`;

/** A conversation's room, joined only after membership is verified. */
export const conversationRoom = (conversationId: string): string =>
  `conversation:${conversationId}`;

/** A call's room, holding exactly the two participants. */
export const callRoom = (callId: string): string => `call:${callId}`;
