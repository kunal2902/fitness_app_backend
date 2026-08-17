import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './config/env.js';
import {
  errorHandler,
  notFoundHandler,
} from './middleware/error.middleware.js';
import { globalLimiter } from './middleware/rateLimit.middleware.js';
import {
  ensureUploadDirs,
  uploadsRoot,
} from './middleware/upload.middleware.js';
import routes from './routes/index.js';

export function createApp(): Express {
  const app = express();

  // Behind a proxy (Render, Railway, nginx) this makes req.ip the real
  // client address, which the rate limiter depends on.
  app.set('trust proxy', 1);

  // crossOriginResourcePolicy must be relaxed or the <img> request from the
  // app is blocked when the API and the client are on different origins.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (!env.isProduction) {
    app.use(morgan('dev'));
  }

  app.use(globalLimiter);

  // Uploaded avatars, served outside the API prefix so the client can load
  // them straight into an <Image> with no auth header. Nothing here is
  // secret; the filenames are random and unguessable.
  ensureUploadDirs();
  app.use(
    env.uploads.publicPath,
    express.static(uploadsRoot, {
      maxAge: '7d',
      // Never let a stored file be executed or interpreted as HTML.
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
      },
    }),
  );

  app.use(env.apiPrefix, routes);

  // Order matters: 404 first, then the error serialiser.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
