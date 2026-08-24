import crypto from 'node:crypto';

import { env } from '../config/env.js';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * Builds the ICE server list a client feeds to `RTCPeerConnection`.
 *
 * TURN credentials use coturn's REST-API scheme: the username is
 * `<expiry-unix>:<userId>` and the password is an HMAC of that username
 * keyed with coturn's `static-auth-secret`. coturn recomputes the same
 * HMAC to validate, so no per-user accounts exist on the TURN server and
 * the shared secret never leaves this process.
 *
 * Credentials are short-lived by design. A leaked one is useless within
 * hours, and a device that keeps a call open past expiry keeps its
 * existing allocation — expiry only blocks *new* allocations.
 */
/**
 * The coturn REST-API derivation, as a pure function.
 *
 * Split out from [buildIceServers] so it can be verified against coturn's
 * spec directly, without standing up an environment — the HMAC has to be
 * byte-identical to what coturn recomputes or every relayed call fails
 * authentication with no useful error.
 */
export function deriveTurnCredential(
  userId: string,
  secret: string,
  ttlSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { username: string; credential: string; expiresAt: number } {
  const expiresAt = nowSeconds + ttlSeconds;
  const username = `${expiresAt}:${userId}`;
  const credential = crypto
    .createHmac('sha1', secret)
    .update(username)
    .digest('base64');

  return { username, credential, expiresAt };
}

export function buildIceServers(userId: string): IceServer[] {
  const servers: IceServer[] = [];

  if (env.ice.stunUrls.length > 0) {
    servers.push({ urls: env.ice.stunUrls });
  }

  const canIssueTurn =
    env.ice.turnUrls.length > 0 && env.ice.turnSecret.length > 0;

  if (canIssueTurn) {
    const { username, credential } = deriveTurnCredential(
      userId,
      env.ice.turnSecret,
      env.ice.turnCredentialTtlSeconds,
    );
    servers.push({ urls: env.ice.turnUrls, username, credential });
  }

  return servers;
}

/**
 * True when a relay is available. Without TURN, calls still work on most
 * home networks but fail behind symmetric NAT and many corporate or
 * mobile-carrier networks — worth surfacing rather than letting the user
 * hit an unexplained connection failure.
 */
export function turnConfigured(): boolean {
  return env.ice.turnUrls.length > 0 && env.ice.turnSecret.length > 0;
}
