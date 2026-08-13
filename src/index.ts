import type { Server } from 'node:http';

import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectToDB, disconnectFromDB } from './utils/dbConnect.js';

async function bootstrap(): Promise<void> {
  // Connect first — booting an API that cannot reach its database just
  // turns every request into a confusing 500.
  await connectToDB();

  const app = createApp();
  const server: Server = app.listen(env.port, () => {
    console.info(
      `[server] listening on http://localhost:${env.port}${env.apiPrefix} (${env.nodeEnv})`,
    );
  });

  const shutdown = (signal: string) => {
    console.info(`[server] ${signal} received, shutting down`);
    server.close(() => {
      void disconnectFromDB().finally(() => process.exit(0));
    });
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((error: unknown) => {
  console.error('[server] failed to start:', error);
  process.exit(1);
});
