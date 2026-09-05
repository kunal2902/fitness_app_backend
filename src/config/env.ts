import dotenv from 'dotenv';

dotenv.config();

/**
 * Reads a required variable, failing loudly at boot rather than at the
 * first request that needs it.
 */
function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        'Copy .env.example to .env and fill it in.',
    );
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isDevelopment: nodeEnv === 'development',
  nutritionTargetPolicyApproval: process.env.NUTRITION_TARGET_POLICY_APPROVAL ?? '',

  foodDataCentral: {
    /** Server-side only. Blank keeps global fallback disabled. */
    apiKey: process.env.FDC_API_KEY ?? '',
    baseUrl: process.env.FDC_API_BASE_URL ?? 'https://api.nal.usda.gov/fdc/v1',
    timeoutMs: Math.min(
      Math.max(optionalNumber('FDC_TIMEOUT_MS', 4_000), 500),
      15_000,
    ),
  },

  port: optionalNumber('PORT', 3000),
  apiPrefix: process.env.API_PREFIX ?? '/api/v1',

  // The project's .env already uses MONGO_URI; MONGODB_URI is accepted as
  // an alias so either spelling works.
  mongoUri: required(
    'MONGO_URI',
    process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/fitness_app',
  ),

  jwt: {
    accessSecret: required(
      'JWT_ACCESS_SECRET',
      nodeEnv === 'production' ? undefined : 'dev-access-secret-change-me',
    ),
    refreshSecret: required(
      'JWT_REFRESH_SECRET',
      nodeEnv === 'production' ? undefined : 'dev-refresh-secret-change-me',
    ),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
    issuer: process.env.JWT_ISSUER ?? 'fitness-app',
  },

  bcryptRounds: optionalNumber('BCRYPT_ROUNDS', 12),

  uploads: {
    /// Where avatar files land. Relative paths resolve from the process cwd.
    dir: process.env.UPLOAD_DIR ?? 'uploads',
    /// Public path prefix the files are served under (outside the API prefix,
    /// so the client can fetch them without an auth header).
    publicPath: '/uploads',
    maxAvatarBytes: optionalNumber('MAX_AVATAR_BYTES', 5 * 1024 * 1024),
  },

  /** Comma-separated list, or `*` in development. */
  corsOrigins: (process.env.CORS_ORIGINS ?? '*')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  realtime: {
    /** How long an unanswered call rings before it is marked missed. */
    ringTimeoutSeconds: optionalNumber('CALL_RING_TIMEOUT_SECONDS', 45),
    /** Grace period for a reconnect before a call is torn down. */
    reconnectGraceSeconds: optionalNumber('CALL_RECONNECT_GRACE_SECONDS', 20),

    /**
     * How long after a socket drops before that user's calls are ended.
     *
     * Long enough to survive a tunnel or a wifi-to-cellular handover,
     * short enough that a force-quit does not leave the other person
     * staring at a live call screen.
     */
    disconnectGraceSeconds: optionalNumber('CALL_DISCONNECT_GRACE_SECONDS', 45),

    /**
     * Hard ceiling on a call. Anything still `accepted`/`connected` past
     * this is assumed dead and reaped — otherwise it marks both people
     * permanently busy. Generous on purpose: ending a live call is worse
     * than a stale row.
     */
    maxCallSeconds: optionalNumber('CALL_MAX_SECONDS', 4 * 3600),
  },

  ice: {
    /** Public STUN servers, comma separated. Free and stateless. */
    stunUrls: (
      process.env.STUN_URLS ??
      'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
    )
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),

    /**
     * coturn, e.g. `turn:turn.example.com:3478`. Without it, calls fail on
     * symmetric NAT — roughly one connection in six.
     */
    turnUrls: (process.env.TURN_URLS ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),

    /**
     * coturn's `static-auth-secret`. Credentials are derived from it per
     * request and expire; the secret itself never reaches a device.
     */
    turnSecret: process.env.TURN_STATIC_AUTH_SECRET ?? '',
    turnCredentialTtlSeconds: optionalNumber('TURN_CREDENTIAL_TTL', 12 * 3600),
  },

  push: {
    /**
     * Path to a Firebase service-account JSON, or the JSON itself.
     * Unset simply disables Android push — the server still runs.
     */
    firebaseCredentials: process.env.FIREBASE_SERVICE_ACCOUNT ?? '',

    /** APNs VoIP — the only way to trigger CallKit on iOS. */
    apnsKeyP8: process.env.APNS_KEY_P8 ?? '',
    apnsKeyId: process.env.APNS_KEY_ID ?? '',
    apnsTeamId: process.env.APNS_TEAM_ID ?? '',
    /** Bundle id; the VoIP topic is this plus `.voip`. */
    apnsBundleId: process.env.APNS_BUNDLE_ID ?? 'com.fitnessapp.fitness_app',
    apnsProduction: process.env.APNS_PRODUCTION === 'true',
  },
} as const;
