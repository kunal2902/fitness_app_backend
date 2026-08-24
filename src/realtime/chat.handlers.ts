import type { Server } from 'socket.io';

import { chatService } from '../services/chat.service.js';
import {
  SocketEvents,
  conversationRoom,
  userRoom,
  type ChatReadPayload,
  type ChatSendPayload,
  type ChatTypingPayload,
} from './events.js';
import {
  safeAck,
  socketError,
  type AppSocket,
  type SocketSession,
} from './socket.js';

export function registerChatHandlers(io: Server, socket: AppSocket): void {
  const session = socket.data as unknown as SocketSession;

  /**
   * Joining a conversation room is gated on membership, checked against
   * the database every time. Room names are guessable, so without this
   * check anyone could join a thread and receive its messages live.
   */
  socket.on(SocketEvents.chatJoin, async (payload: { conversationId: string }, ack) => {
    const respond = safeAck(ack);
    try {
      const conversation = await chatService.requireParticipant(
        payload?.conversationId ?? '',
        session.objectId,
      );
      await socket.join(conversationRoom(conversation._id.toString()));
      respond({ ok: true });
    } catch (error) {
      respond(socketError(error));
    }
  });

  socket.on(SocketEvents.chatLeave, (payload: { conversationId: string }) => {
    if (!payload?.conversationId) return;
    // Leaving needs no check — you can only leave a room you are in.
    void socket.leave(conversationRoom(payload.conversationId));
  });

  socket.on(SocketEvents.chatSend, async (payload: ChatSendPayload, ack) => {
    const respond = safeAck<{ message: unknown; duplicate: boolean }>(ack);
    try {
      const conversation = await chatService.requireParticipant(
        payload?.conversationId ?? '',
        session.objectId,
      );

      const { message, isDuplicate } = await chatService.sendMessage({
        conversation,
        senderId: session.objectId,
        body: payload?.body ?? '',
        clientId: payload?.clientId ?? null,
      });

      // Acknowledge the sender first so their optimistic bubble settles
      // even if the broadcast is slow.
      respond({ ok: true, message, duplicate: isDuplicate });

      if (!isDuplicate) {
        const room = conversationRoom(conversation._id.toString());
        io.to(room).emit(SocketEvents.chatMessage, message);

        // Also to the recipient's user room: they may have the app open on
        // another screen and still need the unread badge to move.
        for (const participant of conversation.participants) {
          if (participant.equals(session.objectId)) continue;
          io.to(userRoom(participant.toString())).emit(
            SocketEvents.chatDelivered,
            {
              conversationId: conversation._id.toString(),
              message,
            },
          );
        }
      }
    } catch (error) {
      respond(socketError(error));
    }
  });

  /**
   * Typing indicators are fire-and-forget and never persisted — a stale
   * "typing…" that outlives the socket is worse than a missed one, so the
   * client also expires it locally on a timer.
   */
  socket.on(SocketEvents.chatTyping, async (payload: ChatTypingPayload) => {
    if (!payload?.conversationId) return;
    try {
      const conversation = await chatService.requireParticipant(
        payload.conversationId,
        session.objectId,
      );
      socket
        .to(conversationRoom(conversation._id.toString()))
        .emit(SocketEvents.chatTyping, {
          conversationId: conversation._id.toString(),
          userId: session.userId,
          isTyping: Boolean(payload.isTyping),
        });
    } catch {
      // A typing ping from a non-participant is simply dropped.
    }
  });

  socket.on(SocketEvents.chatRead, async (payload: ChatReadPayload, ack) => {
    const respond = safeAck(ack);
    try {
      const conversation = await chatService.requireParticipant(
        payload?.conversationId ?? '',
        session.objectId,
      );

      const { readAt } = await chatService.markRead(
        conversation,
        session.objectId,
        payload?.messageId ?? '',
      );

      respond({ ok: true });

      socket
        .to(conversationRoom(conversation._id.toString()))
        .emit(SocketEvents.chatRead, {
          conversationId: conversation._id.toString(),
          userId: session.userId,
          readAt: readAt.toISOString(),
        });
    } catch (error) {
      respond(socketError(error));
    }
  });
}
