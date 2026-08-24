import fs from 'node:fs';
import http2 from 'node:http2';

import {
  cert,
  initializeApp,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';
import {
  getMessaging,
  type BatchResponse,
} from 'firebase-admin/messaging';
import jwt from 'jsonwebtoken';

import { env } from '../config/env.js';
import { DeviceToken } from '../models/deviceToken.model.js';

/**
 * Ringing a device that does not currently have a socket open.
 *
 * Android and iOS need completely different mechanisms and they are not
 * interchangeable:
 *
 *  * **Android** — a high-priority FCM *data* message. Data-only (no
 *    `notification` block) is deliberate: a notification payload is
 *    handled by the system and never reaches the app when it is in the
 *    background, so the app could not raise a full-screen call UI.
 *  * **iOS** — a PushKit VoIP push straight to APNs. FCM cannot send
 *    these, and since iOS 13 a VoIP push that does not report a call to
 *    CallKit gets the app's VoIP privileges revoked, so the handler must
 *    always show the incoming call.
 *
 * Everything degrades to a no-op when credentials are absent, so the
 * server runs fine in development before Firebase or APNs is set up.
 */

let firebaseApp: App | null = null;
let firebaseInitAttempted = false;

function firebase(): App | null {
  if (firebaseInitAttempted) return firebaseApp;
  firebaseInitAttempted = true;

  const raw = env.push.firebaseCredentials;
  if (!raw) {
    console.info('[push] FIREBASE_SERVICE_ACCOUNT unset — Android push off');
    return null;
  }

  try {
    const json: unknown = raw.trim().startsWith('{')
      ? JSON.parse(raw)
      : JSON.parse(fs.readFileSync(raw, 'utf8'));

    firebaseApp = initializeApp({
      credential: cert(json as ServiceAccount),
    });
    console.info('[push] Firebase ready');
  } catch (error) {
    console.error('[push] Firebase init failed — Android push off:', error);
    firebaseApp = null;
  }

  return firebaseApp;
}

export function apnsConfigured(): boolean {
  return Boolean(
    env.push.apnsKeyP8 && env.push.apnsKeyId && env.push.apnsTeamId,
  );
}

/** APNs provider tokens are valid for an hour; Apple rejects reuse under 20 minutes. */
let cachedApnsJwt: { token: string; issuedAt: number } | null = null;

function apnsProviderToken(): string | null {
  if (!apnsConfigured()) return null;

  const now = Math.floor(Date.now() / 1000);
  if (cachedApnsJwt && now - cachedApnsJwt.issuedAt < 45 * 60) {
    return cachedApnsJwt.token;
  }

  const key = env.push.apnsKeyP8.includes('BEGIN PRIVATE KEY')
    ? env.push.apnsKeyP8.replace(/\\n/g, '\n')
    : fs.readFileSync(env.push.apnsKeyP8, 'utf8');

  const token = jwt.sign({ iss: env.push.apnsTeamId, iat: now }, key, {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: env.push.apnsKeyId },
  });

  cachedApnsJwt = { token, issuedAt: now };
  return token;
}

export interface CallPushPayload {
  callId: string;
  conversationId: string;
  callerId: string;
  callerName: string;
  callerAvatarUrl?: string | null;
  withVideo: boolean;
}

export const pushService = {
  async registerDevice(params: {
    userId: string;
    token: string;
    platform: 'android' | 'ios';
    kind: 'fcm' | 'apns_voip';
    deviceId?: string | null;
    appVersion?: string | null;
  }): Promise<void> {
    // Upsert on the token: the same physical device may re-register under
    // a different account, and the row must follow the current owner.
    await DeviceToken.findOneAndUpdate(
      { token: params.token },
      {
        user: params.userId,
        token: params.token,
        platform: params.platform,
        kind: params.kind,
        deviceId: params.deviceId ?? null,
        appVersion: params.appVersion ?? null,
        lastSeenAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  },

  async unregisterDevice(token: string): Promise<void> {
    await DeviceToken.deleteOne({ token });
  },

  async unregisterAllForUser(userId: string): Promise<void> {
    await DeviceToken.deleteMany({ user: userId });
  },

  /** Rings every device belonging to [userId]. Failures never throw. */
  async sendCallInvite(
    userId: string,
    payload: CallPushPayload,
  ): Promise<void> {
    const devices = await DeviceToken.find({ user: userId });
    if (devices.length === 0) return;

    const androidTokens = devices
      .filter((d) => d.platform === 'android' && d.kind === 'fcm')
      .map((d) => d.token);

    const voipTokens = devices
      .filter((d) => d.platform === 'ios' && d.kind === 'apns_voip')
      .map((d) => d.token);

    await Promise.allSettled([
      this._sendFcmCall(androidTokens, payload),
      ...voipTokens.map((token) => this._sendApnsVoip(token, payload)),
    ]);
  },

  /** Tells devices to dismiss a ringing call the user answered elsewhere. */
  async sendCallCancelled(userId: string, callId: string): Promise<void> {
    const devices = await DeviceToken.find({ user: userId });
    const androidTokens = devices
      .filter((d) => d.platform === 'android' && d.kind === 'fcm')
      .map((d) => d.token);

    if (androidTokens.length === 0) return;
    const app = firebase();
    if (!app) return;

    try {
      await getMessaging(app).sendEachForMulticast({
        tokens: androidTokens,
        data: { type: 'call_cancelled', callId },
        android: { priority: 'high' },
      });
    } catch (error) {
      console.error('[push] cancel failed:', error);
    }
  },

  async _sendFcmCall(
    tokens: string[],
    payload: CallPushPayload,
  ): Promise<void> {
    if (tokens.length === 0) return;
    const app = firebase();
    if (!app) return;

    try {
      const result = await getMessaging(app).sendEachForMulticast({
        tokens,
        // Data-only: a `notification` block would be swallowed by the
        // system tray and never reach the background handler that raises
        // the call screen.
        data: {
          type: 'call_invite',
          callId: payload.callId,
          conversationId: payload.conversationId,
          callerId: payload.callerId,
          callerName: payload.callerName,
          callerAvatarUrl: payload.callerAvatarUrl ?? '',
          withVideo: String(payload.withVideo),
        },
        android: {
          priority: 'high',
          // Matches the ring timeout — a push that arrives after the call
          // stopped ringing is worse than no push.
          ttl: env.realtime.ringTimeoutSeconds * 1000,
        },
      });

      await this._pruneDeadTokens(tokens, result);
    } catch (error) {
      console.error('[push] FCM call invite failed:', error);
    }
  },

  async _pruneDeadTokens(
    tokens: string[],
    result: BatchResponse,
  ): Promise<void> {
    const dead: string[] = [];
    result.responses.forEach((response, index: number) => {
      if (response.success) return;
      const code = response.error?.code ?? '';
      if (
        code.includes('registration-token-not-registered') ||
        code.includes('invalid-argument')
      ) {
        const token = tokens[index];
        if (token) dead.push(token);
      }
    });

    if (dead.length > 0) {
      await DeviceToken.deleteMany({ token: { $in: dead } });
      console.info(`[push] pruned ${dead.length} dead token(s)`);
    }
  },

  async _sendApnsVoip(token: string, payload: CallPushPayload): Promise<void> {
    const providerToken = apnsProviderToken();
    if (!providerToken) return;

    const host = env.push.apnsProduction
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';

    await new Promise<void>((resolve) => {
      const client = http2.connect(host);
      client.on('error', (error) => {
        console.error('[push] APNs connection error:', error);
        resolve();
      });

      const body = JSON.stringify({
        callId: payload.callId,
        conversationId: payload.conversationId,
        callerId: payload.callerId,
        callerName: payload.callerName,
        callerAvatarUrl: payload.callerAvatarUrl ?? '',
        withVideo: payload.withVideo,
      });

      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${providerToken}`,
        // `.voip` suffix and push-type voip are both required, and iOS
        // silently drops the push if either is wrong.
        'apns-topic': `${env.push.apnsBundleId}.voip`,
        'apns-push-type': 'voip',
        'apns-priority': '10',
        'apns-expiration': String(
          Math.floor(Date.now() / 1000) + env.realtime.ringTimeoutSeconds,
        ),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });

      let status = 0;
      let responseBody = '';

      request.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      request.on('end', () => {
        if (status !== 200) {
          console.error(`[push] APNs ${status}: ${responseBody}`);
          if (status === 410) {
            // Device token is no longer valid — stop ringing it.
            void DeviceToken.deleteOne({ token });
          }
        }
        client.close();
        resolve();
      });
      request.on('error', (error) => {
        console.error('[push] APNs request error:', error);
        client.close();
        resolve();
      });

      request.end(body);
    });
  },
};
