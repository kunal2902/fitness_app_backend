/** Generates the immutable Step 4 PNG for activities saved before Step 4. */
import mongoose from 'mongoose';

import { Activity } from '../src/models/activity.model.js';
import {
  createRouteThumbnail,
  deleteRouteThumbnail,
} from '../src/tracking/route-thumbnail.store.js';
import { connectToDB, disconnectFromDB } from '../src/utils/dbConnect.js';

async function main(): Promise<void> {
  await connectToDB();

  const cursor = Activity.find({
    encodedPolyline: { $ne: '' },
    $or: [
      { thumbnailUrl: null },
      { thumbnailUrl: { $exists: false } },
    ],
  }).cursor();

  let generated = 0;
  let skipped = 0;
  for await (const activity of cursor) {
    let thumbnailUrl: string | null;
    try {
      thumbnailUrl = await createRouteThumbnail(
        activity._id.toString(),
        activity.encodedPolyline,
        activity.splits,
      );
    } catch (error) {
      skipped += 1;
      console.warn(`Skipped malformed route ${activity._id}:`, error);
      continue;
    }
    if (!thumbnailUrl) {
      skipped += 1;
      continue;
    }

    let result;
    try {
      result = await Activity.updateOne(
        {
          _id: activity._id,
          $or: [
            { thumbnailUrl: null },
            { thumbnailUrl: { $exists: false } },
          ],
        },
        { $set: { thumbnailUrl } },
      );
    } catch (error) {
      await deleteRouteThumbnail(thumbnailUrl);
      throw error;
    }
    if (result.modifiedCount === 1) generated += 1;
    else {
      skipped += 1;
      await deleteRouteThumbnail(thumbnailUrl);
    }
  }

  console.log(`Route thumbnails generated: ${generated}; skipped: ${skipped}`);
}

main()
  .then(disconnectFromDB)
  .catch(async (error: unknown) => {
    console.error(error);
    if (mongoose.connection.readyState !== 0) await disconnectFromDB();
    process.exitCode = 1;
  });
