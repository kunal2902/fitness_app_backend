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
import routes from './routes/index.js';

export function createApp(): Express {
  const app = express();

  // Behind a proxy (Render, Railway, nginx) this makes req.ip the real
  // client address, which the rate limiter depends on.
  app.set('trust proxy', 1);

  app.use(helmet());
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

  app.use(env.apiPrefix, routes);

  // Order matters: 404 first, then the error serialiser.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
