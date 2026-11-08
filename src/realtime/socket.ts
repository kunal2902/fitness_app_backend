import type { Server as HttpServer } from 'node:http';

import mongoose from 'mongoose';
import { Server, type Socket } from 'socket.io';

import { env } from '../config/env.js';
import { User } from '../models/user.model.js';
import { ApiError } from '../utils/apiError.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { registerCallHandlers, startRingTimeoutSweeper } from './call.handlers.js';
import {
  cancelDisconnectSweep,
  scheduleDisconnectSweep,
} from './callLifecycle.js';
import { registerChatHandlers } from './chat.handlers.js';
import { SocketEvents, userRoom, type PresencePayload } from './events.js';
import { broadcastPresence, presence } from './presence.js';

/** What we hang off `socket.data` once the handshake is authenticated. */
export interface SocketSession {
  userId: string;
  objectId: mongoose.Types.ObjectId;
  username: string;
  fullName: string;
  avatarUrl: string | null;
}

/**
 * Left with Socket.IO's default event maps on purpose. Pinning the generic
 * parameters to a typed event map would mean re-declaring every event
 * signature twice, and the handlers already validate their payloads at
 * runtime — where the data actually arrives untyped from the wire.
 */
export type AppSocket = Socket;

let ioInstance: Server | null = null;
let sweeperTimer: NodeJS.Timeout | null = null;

/**
 * Stops the sweeper and closes the server.
 *
 * Closing the Socket.IO server alone leaves the ring-timeout interval
 * running, which then queries a database the caller has already shut down.
 */
export async function closeSocketServer(): Promise<void> {
  if (sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
  const io = ioInstance;
  ioInstance = null;
  if (io) await io.close();
}

/** The live server, for code outside a socket handler that needs to emit. */
export function getIo(): Server {
  if (!ioInstance) {
    throw new Error('Socket.IO has not been initialised yet');
  }
  return ioInstance;
}

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
      credentials: true,
    },
    // A mobile client changing networks reconnects rather than stalling;
    // these keep that detection quick without being chatty.
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // Signalling messages are small. A large cap here would only widen the
    // surface for a memory-exhaustion attempt.
    maxHttpBufferSize: 256 * 1024,
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  io.use(async (socket, next) => {
    /**
     * One rejection path, two audiences.
     *
     * The client only ever learns "UNAUTHORIZED" — an attacker probing
     * tokens must not be told whether the signature, the expiry or the
     * account was the problem. But a developer watching a device retry
     * forever needs to know which it was, so the reason is logged here and
     * never transmitted.
     */
    const deny = (reason: string): void => {
      console.warn(
        `[socket] handshake refused (${reason}) from ${socket.handshake.address}`,
      );
      next(new Error('UNAUTHORIZED'));
    };

    try {
      const raw =
        (socket.handshake.auth as { token?: unknown } | undefined)?.token ??
        socket.handshake.headers.authorization;

      const token =
        typeof raw === 'string'
          ? raw.replace(/^Bearer\s+/i, '').trim()
          : '';

      if (!token) {
        deny(raw === undefined ? 'no token supplied' : 'token was not a string');
        return;
      }

      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub);
      if (!user) {
        deny(`no account for subject ${payload.sub}`);
        return;
      }

      const session: SocketSession = {
        userId: user._id.toString(),
        objectId: user._id,
        username: user.username,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl ?? null,
      };
      Object.assign(socket.data, session);
      next();
    } catch (error) {
      // Covers an expired or wrongly-signed token, a bad issuer, and a
      // database hiccup during the account lookup. The last of those is
      // transient, which is why the client retries with backoff rather than
      // treating a refusal as permanent.
      deny(error instanceof Error ? error.message : 'verification threw');
    }
  });

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  io.on('connection', (socket) => {
    const session = socket.data as unknown as SocketSession;
    const { userId } = session;

    // Every device joins the user's room, so an event addressed to a user
    // reaches phone and tablet alike.
    void socket.join(userRoom(userId));

    const cameOnline = presence.addSocket(userId, socket.id);
    if (cameOnline) broadcastPresence(io, userId, true);

    // They are back inside the grace window — call off the sweep that
    // would have ended their calls. A tunnel or a wifi-to-cellular
    // handover drops the socket while the media stream carries on fine.
    cancelDisconnectSweep(userId);

    socket.emit(SocketEvents.connected, {
      userId,
      serverTime: new Date().toISOString(),
    });

    // ---- presence subscriptions ----
    socket.on(SocketEvents.presenceSubscribe, (payload: PresencePayload) => {
      const ids = Array.isArray(payload?.userIds) ? payload.userIds : [];
      // Bounded so one client cannot make itself a watcher of everyone.
      const capped = ids.slice(0, 100);
      presence.watch(userId, capped);

      socket.emit(SocketEvents.presenceSnapshot, {
        users: capped.map((id) => ({
          userId: id,
          isOnline: presence.isOnline(id),
          lastSeenAt: presence.lastSeen(id)?.toISOString() ?? null,
        })),
      });
    });

    socket.on(SocketEvents.presenceUnsubscribe, (payload: PresencePayload) => {
      presence.unwatch(
        userId,
        Array.isArray(payload?.userIds) ? payload.userIds : undefined,
      );
    });

    registerChatHandlers(io, socket);
    registerCallHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      const wentOffline = presence.removeSocket(userId, socket.id);
      if (wentOffline) {
        presence.unwatch(userId);
        broadcastPresence(io, userId, false);

        // Their last device is gone. If they were on a call, nothing else
        // will ever end it — a force-quit sends no hang-up — and while
        // that row lives, both participants are reported busy on every
        // future call. Scheduled, not immediate: see the grace comment in
        // callLifecycle.
        scheduleDisconnectSweep(
          io,
          userId,
          session.objectId,
          env.realtime.disconnectGraceSeconds,
        );
      }
      if (env.isDevelopment) {
        console.info(`[socket] ${session.username} disconnected (${reason})`);
      }
    });
  });

  ioInstance = io;
  // Held so it can actually be stopped. Dropping the handle left no way to
  // shut the sweeper down, which a test harness notices as queries firing
  // after its database has gone.
  sweeperTimer = startRingTimeoutSweeper(io);
  return io;
}

/**
 * Uniform failure reply for socket handlers.
 *
 * Socket.IO has no status codes, so every handler that can fail takes an
 * acknowledgement callback and answers `{ ok: false, ... }` rather than
 * throwing into the void — a client waiting on an ack would otherwise hang
 * until its own timeout.
 */
export function socketError(error: unknown): {
  ok: false;
  message: string;
  code: string;
} {
  if (error instanceof ApiError) {
    return { ok: false, message: error.message, code: error.code };
  }
  console.error('[socket] handler error:', error);
  return {
    ok: false,
    message: 'Something went wrong.',
    code: 'INTERNAL_ERROR',
  };
}

export type Ack<T = Record<string, unknown>> = (
  response: ({ ok: true } & T) | { ok: false; message: string; code: string },
) => void;

/** Handlers receive whatever the client sent — never trust the shape. */
export function safeAck<T>(ack: unknown): Ack<T> {
  return typeof ack === 'function' ? (ack as Ack<T>) : () => {};
}
