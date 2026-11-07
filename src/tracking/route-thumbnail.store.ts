import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import type { IActivitySplit } from '../models/activity.model.js';
import {
  ensureUploadDirs,
  routeThumbnailsDir,
} from '../middleware/upload.middleware.js';
import { env } from '../config/env.js';
import { renderRouteThumbnail } from './route-thumbnail.js';

export async function createRouteThumbnail(
  activityId: string,
  encodedPolyline: string,
  splits: ReadonlyArray<IActivitySplit>,
): Promise<string | null> {
  const png = renderRouteThumbnail(encodedPolyline, splits);
  if (!png) return null;

  ensureUploadDirs();
  // Route images are intentionally public so ordinary image widgets and share
  // sheets can load them without bearer headers. Keep the URL unguessable:
  // an ObjectId alone exposes time and has too little secrecy for location data.
  const filename = `${activityId}-${randomBytes(16).toString('hex')}.png`;
  const destination = path.join(routeThumbnailsDir, filename);
  const temporary = path.join(
    routeThumbnailsDir,
    `.${activityId}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, png, { flag: 'wx' });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return `${env.uploads.publicPath}/tracking/${filename}`;
}

export async function deleteRouteThumbnail(
  thumbnailUrl: string | null | undefined,
): Promise<void> {
  if (!thumbnailUrl) return;
  const filename = path.basename(thumbnailUrl);
  if (!/^[a-fA-F0-9]{24}-[a-fA-F0-9]{32}\.png$/.test(filename)) return;
  await fs.rm(path.join(routeThumbnailsDir, filename), { force: true });
}
