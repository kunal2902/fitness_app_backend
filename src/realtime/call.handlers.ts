import type { Server } from 'socket.io';

import { env } from '../config/env.js';
import { callService } from '../services/call.service.js';
import { chatService } from '../services/chat.service.js';
import { pushService } from '../services/push.service.js';
import { buildIceServers, turnConfigured } from '../services/turn.service.js';
import {
  SocketEvents,
  callRoom,
  userRoom,
  type CallIcePayload,
  type CallIdPayload,
  type CallInvitePayload,
  type CallRejectPayload,
  type CallSdpPayload,
} from './events.js';
import { appendCallEntry, endCallAndNotify } from './callLifecycle.js';
import { presence } from './presence.js';
import {
  safeAck,
  socketError,
  type AppSocket,
  type SocketSession,
} from './socket.js';

/**
 * Narrows a client-supplied reject reason to one the call log accepts.
 *
 * A whitelist, not a default-to-declined coercion: the callee's own ring
 * timeout rejects with 'missed', and folding that into 'declined' writes
 * "Video call declined" into the thread for a call nobody ever saw.
 * Exported so selfcheck can pin the mapping — it is the kind of thing a
 * later edit silently un-fixes.
 */
export function normaliseRejectReason(
  raw: unknown,
): 'declined' | 'busy' | 'missed' {
  return raw === 'busy' || raw === 'missed' ? raw : 'declined';
}

/**
 * WebRTC signalling.
 *
 * The server relays offers, answers and ICE candidates without ever
 * parsing them — it only checks that the sender is one of the two people
 * on the call. Media flows peer-to-peer (or through TURN); it never
 * touches this process.
 */
export function registerCallHandlers(io: Server, socket: AppSocket): void {
  const session = socket.data as unknown as SocketSession;

  /** Relays a signalling payload to the other participant's devices. */
  const relay = async (
    event: string,
    payload: { callId?: string },
    ack: unknown,
  ) => {
    const respond = safeAck(ack);
    try {
      const call = await callService.requireParticipant(
        payload?.callId ?? '',
        session.objectId,
      );

      const otherId = call.caller.equals(session.objectId)
        ? call.callee
        : call.caller;

      io.to(userRoom(otherId.toString())).emit(event, {
        ...payload,
        fromUserId: session.userId,
      });
      respond({ ok: true });
    } catch (error) {
      respond(socketError(error));
    }
  };

  // -------------------------------------------------------------------------
  // Invite
  // -------------------------------------------------------------------------

  socket.on(SocketEvents.callInvite, async (payload: CallInvitePayload, ack) => {
    const respond = safeAck<{
      iceServers: unknown;
      turnAvailable: boolean;
      calleeOnline: boolean;
    }>(ack);

    try {
      const conversation = await chatService.requireParticipant(
        payload?.conversationId ?? '',
        session.objectId,
      );

      const calleeId = conversation.participants.find(
        (id) => !id.equals(session.objectId),
      );
      if (!calleeId) throw new Error('NO_CALLEE');

      // Two people cannot ring the same person at once, and nobody can be
      // on two calls. Checked before creating so the second caller gets a
      // clean busy signal rather than a half-created session.
      const busy = await callService.activeCallFor(calleeId);
      if (busy) {
        respond({
          ok: false,
          message: 'They are on another call right now.',
          code: 'CALLEE_BUSY',
        });
        return;
      }

      // And the caller has to be free too. The client guards this, but a
      // second client, a stale bloc or a replayed emit would otherwise
      // create a second live session for one person — after which
      // activeCallFor returns an arbitrary one of them and the busy check
      // above becomes a coin flip.
      const alreadyInCall = await callService.activeCallFor(session.objectId);
      if (alreadyInCall) {
        respond({
          ok: false,
          message: 'You are already on a call.',
          code: 'ALREADY_IN_CALL',
        });
        return;
      }

      const call = await callService.create({
        callId: payload.callId,
        conversation,
        callerId: session.objectId,
        withVideo: payload.withVideo !== false,
      });

      await socket.join(callRoom(call.callId));

      const calleeOnline = presence.isOnline(calleeId.toString());

      io.to(userRoom(calleeId.toString())).emit(SocketEvents.callIncoming, {
        callId: call.callId,
        conversationId: conversation._id.toString(),
        withVideo: call.withVideo,
        caller: {
          id: session.userId,
          name: session.fullName,
          avatarUrl: session.avatarUrl,
        },
        expiresInSeconds: env.realtime.ringTimeoutSeconds,
      });

      // Ring the device even when no socket is open. Push is best-effort:
      // a failure here must not abort a call that may still connect via
      // the socket the callee has open.
      void pushService
        .sendCallInvite(calleeId.toString(), {
          callId: call.callId,
          conversationId: conversation._id.toString(),
          callerId: session.userId,
          callerName: session.fullName,
          callerAvatarUrl: session.avatarUrl,
          withVideo: call.withVideo,
        })
        .catch((error: unknown) => {
          console.error('[call] push invite failed:', error);
        });

      respond({
        ok: true,
        iceServers: buildIceServers(session.userId),
        turnAvailable: turnConfigured(),
        calleeOnline,
      });
    } catch (error) {
      respond(socketError(error));
    }
  });

  // -------------------------------------------------------------------------
  // Accept / reject / cancel / end
  // -------------------------------------------------------------------------

  socket.on(SocketEvents.callAccept, async (payload: CallIdPayload, ack) => {
    const respond = safeAck<{ iceServers: unknown; turnAvailable: boolean }>(ack);
    try {
      const call = await callService.requireParticipant(
        payload?.callId ?? '',
        session.objectId,
      );

      if (!call.callee.equals(session.objectId)) {
        respond({
          ok: false,
          message: 'Only the person being called can accept.',
          code: 'NOT_CALLEE',
        });
        return;
      }
      if (call.state === 'ended') {
        respond({
          ok: false,
          message: 'That call has already ended.',
          code: 'CALL_ENDED',
        });
        return;
      }

      // Atomic claim. Two of the callee's own devices can answer inside
      // one round trip; without this both "succeed", each sends the other
      // `answered_elsewhere`, both hang up, and the caller is left
      // connecting to nobody. Exactly one device wins here.
      const claimed = await callService.claimForAccept(call);
      if (!claimed) {
        respond({
          ok: false,
          message: 'That call was already answered.',
          code: 'ALREADY_ANSWERED',
        });
        return;
      }

      await socket.join(callRoom(call.callId));

      respond({
        ok: true,
        iceServers: buildIceServers(session.userId),
        turnAvailable: turnConfigured(),
      });

      io.to(userRoom(call.caller.toString())).emit(SocketEvents.callAccepted, {
        callId: call.callId,
        acceptedBy: session.userId,
      });

      // Stop the callee's *other* devices ringing.
      socket.to(userRoom(session.userId)).emit(SocketEvents.callCancelled, {
        callId: call.callId,
        reason: 'answered_elsewhere',
      });
      void pushService.sendCallCancelled(session.userId, call.callId);
    } catch (error) {
      respond(socketError(error));
    }
  });

  socket.on(SocketEvents.callReject, async (payload: CallRejectPayload, ack) => {
    const respond = safeAck(ack);
    try {
      const call = await callService.requireParticipant(
        payload?.callId ?? '',
        session.objectId,
      );

      const reason = normaliseRejectReason(payload?.reason);

      const { alreadyEnded } = await callService.end(call, reason);
      respond({ ok: true });
      if (alreadyEnded) return;

      io.to(userRoom(call.caller.toString())).emit(SocketEvents.callRejected, {
        callId: call.callId,
        reason,
      });
      socket.to(userRoom(session.userId)).emit(SocketEvents.callCancelled, {
        callId: call.callId,
        reason: 'handled_elsewhere',
      });

      await appendCallEntry(io, call.callId);
      void pushService.sendCallCancelled(session.userId, call.callId);
    } catch (error) {
      respond(socketError(error));
    }
  });

  socket.on(SocketEvents.callCancel, async (payload: CallIdPayload, ack) => {
    const respond = safeAck(ack);
    try {
      const call = await callService.requireParticipant(
        payload?.callId ?? '',
        session.objectId,
      );

      // Hanging up before the other side answers is a cancel; after, it is
      // a completed call. The distinction is what the chat row shows.
      const wasRinging = call.state === 'ringing';
      const { alreadyEnded } = await callService.end(
        call,
        wasRinging ? 'cancelled' : 'completed',
      );
      respond({ ok: true });
      if (alreadyEnded) return;

      io.to(userRoom(call.callee.toString())).emit(SocketEvents.callCancelled, {
        callId: call.callId,
        reason: 'cancelled',
      });
      await appendCallEntry(io, call.callId);
      void pushService.sendCallCancelled(call.callee.toString(), call.callId);
    } catch (error) {
      respond(socketError(error));
    }
  });

  socket.on(SocketEvents.callEnd, async (payload: CallIdPayload, ack) => {
    const respond = safeAck(ack);
    try {
      const call = await callService.requireParticipant(
        payload?.callId ?? '',
        session.objectId,
      );

      const wasRinging = call.state === 'ringing';
      const { alreadyEnded } = await callService.end(
        call,
        wasRinging ? 'cancelled' : 'completed',
      );
      respond({ ok: true });
      if (alreadyEnded) return;

      const otherId = call.caller.equals(session.objectId)
        ? call.callee
        : call.caller;

      io.to(userRoom(otherId.toString())).emit(SocketEvents.callEnded, {
        callId: call.callId,
        endedBy: session.userId,
        durationSeconds: call.durationSeconds ?? 0,
      });

      await appendCallEntry(io, call.callId);
    } catch (error) {
      respond(socketError(error));
    }
  });

  // -------------------------------------------------------------------------
  // Signalling relay — payloads are opaque
  // -------------------------------------------------------------------------

  socket.on(SocketEvents.callOffer, (payload: CallSdpPayload, ack) => {
    void relay(SocketEvents.callOffer, payload, ack);
  });

  socket.on(SocketEvents.callAnswer, async (payload: CallSdpPayload, ack) => {
    await relay(SocketEvents.callAnswer, payload, ack);
    // An answer means media is being negotiated — the call is live.
    try {
      const call = await callService.find(payload?.callId ?? '');
      if (call) await callService.markConnected(call);
    } catch {
      // Bookkeeping only; never fail the answer over it.
    }
  });

  socket.on(SocketEvents.callIce, (payload: CallIcePayload, ack) => {
    void relay(SocketEvents.callIce, payload, ack);
  });
}

/**
 * Ends calls nobody answered, and calls nobody ever ended.
 *
 * Two separate leaks, one sweeper:
 *
 *  * A caller who force-quits while it is still ringing leaves the callee
 *    permanently "busy", and no missed-call row is ever written.
 *  * A call that reached `accepted`/`connected` and then died on both
 *    ends at once — an ICE failure with no TURN, two crashes, a server
 *    restart mid-call — leaves a row that marks BOTH people busy forever.
 *    Nothing else clears it, and there is no way out of that from inside
 *    the app.
 */
export function startRingTimeoutSweeper(io: Server): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      try {
        for (const call of await callService.expiredRingingCalls()) {
          await endCallAndNotify(io, call, 'missed');
        }
        for (const call of await callService.stalledCalls()) {
          await endCallAndNotify(io, call, 'failed');
        }
      } catch (error) {
        console.error('[call] sweeper failed:', error);
      }
    })();
  }, 10_000);

  // Must not keep the process alive on shutdown.
  timer.unref();
  return timer;
}
