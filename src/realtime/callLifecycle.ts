import type { Server } from 'socket.io';

import { Conversation } from '../models/conversation.model.js';
import type {
  CallEndReason,
  CallSessionDocument,
} from '../models/callSession.model.js';
import { callService } from '../services/call.service.js';
import { pushService } from '../services/push.service.js';
import { SocketEvents, userRoom } from './events.js';

/**
 * The one place a call is ended.
 *
 * Every route to an ended call — a hang-up over the socket, the REST
 * escape hatch when the socket died, a ring timeout, a dropped
 * connection, the stalled-call reaper — has to do the same four things:
 * mark the session ended, tell the other side, write the row into the
 * chat thread, and stop the callee's phone ringing. Earlier versions had
 * some of those in the socket handler and none of them in the REST
 * controller, so hanging up while offline left the peer on a live call
 * screen and the call missing from both histories.
 *
 * Returns false when the call had already ended — callers use that to
 * avoid emitting a second time.
 */
export async function endCallAndNotify(
  io: Server,
  call: CallSessionDocument,
  reason: CallEndReason,
): Promise<boolean> {
  const wasRinging = call.state === 'ringing';
  const { alreadyEnded } = await callService.end(call, reason);
  if (alreadyEnded) return false;

  const callerRoom = userRoom(call.caller.toString());
  const calleeRoom = userRoom(call.callee.toString());

  if (wasRinging) {
    // Different events on purpose: the caller's UI shows an outcome
    // ("No answer"), while the callee's job is simply to stop ringing.
    //
    // `declined` and `busy` go out as `call:rejected`, not `call:ended`.
    // The client's `call:ended` listener only distinguishes `missed`, so
    // routing a decline through it would show the caller "Call ended" for
    // a call that was actively refused. That matters most on the path
    // that gets here — the HTTP fallback, used when the decliner's socket
    // was down — because it would silently disagree with the socket path.
    const rejectedEvent = reason === 'declined' || reason === 'busy';

    io.to(callerRoom).emit(
      rejectedEvent ? SocketEvents.callRejected : SocketEvents.callEnded,
      rejectedEvent
        ? { callId: call.callId, reason }
        : { callId: call.callId, reason, durationSeconds: 0 },
    );
    io.to(calleeRoom).emit(SocketEvents.callCancelled, {
      callId: call.callId,
      reason,
    });
  } else {
    const ended = {
      callId: call.callId,
      reason,
      durationSeconds: call.durationSeconds ?? 0,
    };
    io.to(callerRoom).emit(SocketEvents.callEnded, ended);
    io.to(calleeRoom).emit(SocketEvents.callEnded, ended);
  }

  await appendCallEntry(io, call.callId);

  // Dismiss the native ringer on the callee's other devices. Best-effort:
  // a push failure must not stop the call from being ended.
  void pushService
    .sendCallCancelled(call.callee.toString(), call.callId)
    .catch(() => undefined);

  return true;
}

/** Writes the finished call into the chat thread. */
export async function appendCallEntry(
  io: Server,
  callId: string,
): Promise<void> {
  try {
    const call = await callService.find(callId);
    if (!call) return;

    const conversation = await Conversation.findById(call.conversation);
    if (!conversation) return;

    await callService.appendCallMessage(call, conversation);

    // Refresh both timelines so the call row appears without a reload.
    for (const participant of conversation.participants) {
      io.to(userRoom(participant.toString())).emit(SocketEvents.chatDelivered, {
        conversationId: conversation._id.toString(),
        message: null,
        refresh: true,
      });
    }
  } catch (error) {
    console.error('[call] could not append call entry:', error);
  }
}

/**
 * Ends every live call a user is in, a while after their socket drops.
 *
 * The grace period is what makes this safe: a wifi-to-cellular handover
 * or a tunnel drops the socket for a few seconds while the media stream
 * carries on perfectly well over ICE, and ending the call there would be
 * a worse bug than the one this fixes. If they reconnect inside the
 * window, [cancelDisconnectSweep] calls it off.
 *
 * Without this, a force-quit mid-call leaves the session `connected`
 * forever and both people are reported busy on every future attempt.
 */
const pendingDisconnects = new Map<string, NodeJS.Timeout>();

export function scheduleDisconnectSweep(
  io: Server,
  userId: string,
  objectId: Parameters<typeof callService.activeCallsForUser>[0],
  graceSeconds: number,
): void {
  cancelDisconnectSweep(userId);

  const timer = setTimeout(() => {
    pendingDisconnects.delete(userId);
    void (async () => {
      try {
        const calls = await callService.activeCallsForUser(objectId);
        for (const call of calls) {
          await endCallAndNotify(
            io,
            call,
            call.state === 'ringing' ? 'cancelled' : 'failed',
          );
        }
      } catch (error) {
        console.error('[call] disconnect sweep failed:', error);
      }
    })();
  }, graceSeconds * 1000);

  timer.unref();
  pendingDisconnects.set(userId, timer);
}

export function cancelDisconnectSweep(userId: string): void {
  const existing = pendingDisconnects.get(userId);
  if (!existing) return;
  clearTimeout(existing);
  pendingDisconnects.delete(userId);
}

/** Test seam — the sweep map is process-local state. */
export function pendingDisconnectCount(): number {
  return pendingDisconnects.size;
}
