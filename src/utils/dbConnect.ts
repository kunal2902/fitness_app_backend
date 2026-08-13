import mongoose from 'mongoose';

import { env } from '../config/env.js';

/**
 * Opens the Mongo connection and keeps a single shared instance.
 *
 * Note: awaiting `mongoose.connect` is enough — do not also chain
 * `.then()/.catch()` on it, or a failure gets swallowed and the server
 * boots against a dead database.
 */
export async function connectToDB(): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => {
    console.info('[db] connected');
  });
  mongoose.connection.on('error', (err) => {
    console.error('[db] connection error:', err);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('[db] disconnected');
  });

  return mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
  });
}

export async function disconnectFromDB(): Promise<void> {
  await mongoose.connection.close();
}
