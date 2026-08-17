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
} as const;
