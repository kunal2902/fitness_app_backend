import type { Server } from 'socket.io';

import { SocketEvents, userRoom } from './events.js';

/**
 * Who is online, right now.
 *
 * Deliberately in-process: presence is ephemeral, and a restart losing it
 * is correct — every client reconnects within seconds and repopulates it.
 * The moment this runs on more than one instance, swap the two maps for
 * Redis and add the Socket.IO Redis adapter; nothing outside this file
 * needs to change.
 */
class PresenceRegistry {
  /** userId → set of that user's live socket ids. */
  private readonly _sockets = new Map<string, Set<string>>();

  /** userId → when their last socket disconnected. */
  private readonly _lastSeen = new Map<string, Date>();

  /** userId → set of userIds who asked to be told about their presence. */
  private readonly _watchers = new Map<string, Set<string>>();

  isOnline(userId: string): boolean {
    const set = this._sockets.get(userId);
    return set !== undefined && set.size > 0;
  }

  lastSeen(userId: string): Date | null {
    return this._lastSeen.get(userId) ?? null;
  }

  snapshot(userId: string): { isOnline: boolean; lastSeenAt: Date | null } {
    return { isOnline: this.isOnline(userId), lastSeenAt: this.lastSeen(userId) };
  }

  socketIds(userId: string): string[] {
    return Array.from(this._sockets.get(userId) ?? []);
  }

  /** Returns true if this was the user's first connection. */
  addSocket(userId: string, socketId: string): boolean {
    const set = this._sockets.get(userId) ?? new Set<string>();
    const wasOffline = set.size === 0;
    set.add(socketId);
    this._sockets.set(userId, set);
    return wasOffline;
  }

  /** Returns true if that was the user's last connection. */
  removeSocket(userId: string, socketId: string): boolean {
    const set = this._sockets.get(userId);
    if (!set) return false;
    set.delete(socketId);
    if (set.size > 0) return false;

    this._sockets.delete(userId);
    this._lastSeen.set(userId, new Date());
    return true;
  }

  watch(watcherId: string, targetIds: string[]): void {
    for (const target of targetIds) {
      const set = this._watchers.get(target) ?? new Set<string>();
      set.add(watcherId);
      this._watchers.set(target, set);
    }
  }

  unwatch(watcherId: string, targetIds?: string[]): void {
    const targets = targetIds ?? Array.from(this._watchers.keys());
    for (const target of targets) {
      const set = this._watchers.get(target);
      if (!set) continue;
      set.delete(watcherId);
      if (set.size === 0) this._watchers.delete(target);
    }
  }

  watchersOf(userId: string): string[] {
    return Array.from(this._watchers.get(userId) ?? []);
  }
}

export const presence = new PresenceRegistry();

/**
 * Tells everyone watching [userId] that their status changed.
 *
 * Only watchers, never a global broadcast: with a few thousand users
 * online, broadcasting every connect would be a stampede, and almost
 * nobody cares about almost everybody.
 */
export function broadcastPresence(
  io: Server,
  userId: string,
  isOnline: boolean,
): void {
  const payload = {
    userId,
    isOnline,
    lastSeenAt: presence.lastSeen(userId)?.toISOString() ?? null,
  };

  for (const watcherId of presence.watchersOf(userId)) {
    io.to(userRoom(watcherId)).emit(SocketEvents.presenceUpdate, payload);
  }
}
