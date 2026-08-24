import type { Server } from 'node:http';

import { createApp } from './app.js';
import { env } from './config/env.js';
import { createSocketServer } from './realtime/socket.js';
import { turnConfigured } from './services/turn.service.js';
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
    if (!turnConfigured()) {
      console.warn(
        '[server] no TURN configured (TURN_URLS + TURN_STATIC_AUTH_SECRET). ' +
          'Calls will work on most home networks but fail behind symmetric ' +
          'NAT — roughly one connection in six.',
      );
    }
  });

  // Socket.IO shares the HTTP server, so chat, signalling and the REST API
  // all live on one port and one origin — no extra CORS or firewall rules.
  const io = createSocketServer(server);

  const shutdown = (signal: string) => {
    console.info(`[server] ${signal} received, shutting down`);
    // Close sockets first so clients get a clean disconnect and start
    // reconnecting, rather than hanging until their ping timeout.
    void io.close(() => {
      server.close(() => {
        void disconnectFromDB().finally(() => process.exit(0));
      });
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
