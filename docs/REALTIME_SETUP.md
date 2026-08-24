# Realtime setup — TURN, FCM and APNs

Everything in the assistance feature works out of the box on a LAN with
nothing configured. This document is about the three pieces of external
infrastructure that make it work *in the real world*, in the order they
start to matter.

| What | Without it | Who needs it |
| --- | --- | --- |
| **coturn (TURN)** | Roughly 1 call in 6 never connects | Anyone testing on mobile data |
| **FCM** | Android does not ring when the app is backgrounded or killed | Android |
| **APNs VoIP** | iOS does not ring at all unless the app is open | iOS |

None of them are required for the app to run. Each is read from the
environment and disables itself cleanly when unset — the server logs a
line and carries on, and the client falls back to socket-only calling.

---

## 1. coturn

WebRTC connects peer-to-peer when it can. It cannot when both ends are
behind symmetric NAT, which is the normal situation on mobile carrier
networks. TURN is the relay that covers that case. STUN alone is not a
substitute: STUN only *discovers* your public address, it does not relay
anything.

### Install

```bash
sudo apt install coturn
sudo systemctl enable coturn
```

### `/etc/turnserver.conf`

```conf
listening-port=3478
tls-listening-port=5349

# The server's PUBLIC IP. On a cloud VM this is not the address the
# machine sees on its own interface — get it wrong and every relay
# candidate points somewhere unreachable.
external-ip=YOUR.PUBLIC.IP

realm=turn.yourdomain.com
server-name=turn.yourdomain.com

# Time-limited credentials derived from a shared secret. The alternative
# (static usernames) means shipping a permanent password inside the app,
# where anyone can pull it out of the binary and use your bandwidth.
use-auth-secret
static-auth-secret=GENERATE_A_LONG_RANDOM_STRING

fingerprint
no-multicast-peers
# Block the relay from being used to reach your own private network.
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

cert=/etc/letsencrypt/live/turn.yourdomain.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.yourdomain.com/privkey.pem
```

Open UDP/TCP 3478, TCP 5349, and the relay range (UDP 49152–65535).

### Backend `.env`

```env
TURN_URLS=turn:turn.yourdomain.com:3478,turns:turn.yourdomain.com:5349
TURN_STATIC_AUTH_SECRET=the-same-long-random-string
TURN_CREDENTIAL_TTL=43200
```

### How the credential works

`src/services/turn.service.ts` derives, per request:

```
username   = <unix expiry>:<userId>
credential = base64( HMAC-SHA1( username, static-auth-secret ) )
```

coturn recomputes the same HMAC and accepts it until the expiry passes.
The secret itself never leaves the server. `deriveTurnCredential` is a
pure function precisely so this can be verified without a coturn
instance — `npm run selfcheck` pins it against the spec.

### Verifying

Paste a credential from `GET /api/v1/assistance/ice` into
<https://icetest.info> or Google's Trickle ICE page. You want to see at
least one candidate of type `relay`. If you only see `host` and `srflx`,
TURN is not working, and calls will fail on mobile data while continuing
to work perfectly on your office wifi — which is exactly how this bug
reaches production.

---

## 2. Firebase Cloud Messaging (Android ringing)

### Console

1. Create a Firebase project, add an **Android** app with package name
   `com.fitnessapp.fitness_app`.
2. Download `google-services.json` → `app_frontend/android/app/`.
3. Uncomment `id("com.google.gms.google-services")` in
   `android/app/build.gradle.kts`. **Applying that plugin without the
   JSON file present fails the build**, which is why it ships commented.
4. Project settings → Service accounts → generate a private key.

### Backend `.env`

```env
# Either a path to the file, or the JSON itself (handy on a PaaS with no
# writable filesystem).
FIREBASE_SERVICE_ACCOUNT=/etc/secrets/firebase-service-account.json
```

### The one thing that will bite you

Call pushes are sent **data-only** — no `notification` block. This is not
a stylistic choice. A message containing `notification` is handled by the
Android system tray when the app is backgrounded, and the Dart background
handler is never invoked, so the app never learns there is a call to ring
about. `src/services/push.service.ts` sends `data` plus
`android.priority: 'high'` for exactly this reason. Adding a
`notification` block "so it shows something" silently breaks background
ringing.

Note also that FCM stringifies every data value. `withVideo: true`
arrives as `"true"`. Both the Dart background handler and the CallKit
extras parsing coerce it back; if you add a boolean or numeric field,
coerce it on the client too.

---

## 3. APNs VoIP (iOS ringing)

iOS cannot use FCM for this. CallKit's full-screen ringer is only allowed
in response to a **PushKit** VoIP push, and Firebase does not send those,
so the server talks to APNs directly over HTTP/2 (`node:http2`, no extra
dependency) with an ES256 JWT.

### Apple Developer portal

1. Enable the **Push Notifications** capability on the App ID.
2. Xcode → Signing & Capabilities → add **Background Modes** and tick
   *Voice over IP* and *Audio*, and add **Push Notifications**.
3. Create a **Key** with APNs enabled, download the `.p8` — Apple lets
   you download it exactly once.

### Backend `.env`

```env
APNS_KEY_P8=/etc/secrets/AuthKey_ABC123XYZ.p8
APNS_KEY_ID=ABC123XYZ
APNS_TEAM_ID=YOURTEAMID
APNS_BUNDLE_ID=com.fitnessapp.fitness_app
APNS_PRODUCTION=false        # true for TestFlight and the App Store
```

The VoIP topic is `APNS_BUNDLE_ID` + `.voip` — a different topic from
regular notifications, and a common cause of `400 BadTopic`.

`APNS_PRODUCTION` selects `api.push.apple.com` over
`api.sandbox.push.apple.com`. A token minted in one environment is
rejected by the other with `BadDeviceToken`, which is why a build that
rings perfectly in Xcode goes silent the moment it ships through
TestFlight.

### Two device tokens per iPhone

An iOS device registers **twice**: an FCM token (`kind: 'fcm'`) for
ordinary notifications and a PushKit token (`kind: 'apns_voip'`) for
calls. They are different strings and are not interchangeable.
`DeviceToken` is unique on `token`, so both rows coexist happily.

### Apple's rule

Every VoIP push **must** result in a reported CallKit call. Receiving one
and not reporting a call gets the app's VoIP privileges revoked by the
OS. `flutter_callkit_incoming` reports the call for us from native code
before Dart runs — which is also why iOS ringing works even when the app
has been killed.

---

## Checking what is actually on

```bash
npm run selfcheck     # 95 checks, no database or network needed
```

At boot the server logs one line per subsystem. `GET /api/v1/assistance/ice`
returns `turnAvailable: false` when TURN is unconfigured; the client shows
calls as available either way, because a same-network call still connects
without a relay.
