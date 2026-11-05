/**
 * Makes each collection's indexes match the Mongoose schemas: builds missing ones and drops ones the
 * schemas no longer declare.
 *
 *   npm run db:sync-indexes -w @vibe/api
 *
 * Production runs with autoIndex off, so index changes ship as an explicit, reviewable step (run
 * during a deploy, ideally against a replica set with rolling builds for large collections) rather
 * than silently on application startup.
 */
import mongoose from 'mongoose';
import { z } from 'zod';
import '../src/modules/comments/comment.model.js';
import '../src/modules/engagement/engagement.models.js';
import '../src/modules/media/media.model.js';
import '../src/modules/messages/message.models.js';
import '../src/modules/notifications/notification.model.js';
import '../src/modules/posts/post.model.js';
import '../src/modules/relationships/block.model.js';
import '../src/modules/relationships/follow.model.js';
import '../src/modules/stories/story.model.js';
import '../src/modules/users/user.model.js';

const { MONGODB_URI } = z
  .object({ MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//) })
  .parse(process.env);

async function main() {
  await mongoose.connect(MONGODB_URI, { autoIndex: false });
  for (const model of Object.values(mongoose.models)) {
    const dropped = await model.syncIndexes();
    const names = (await model.listIndexes()).map((index: { name: string }) => index.name);
    console.log(
      `${model.collection.collectionName.padEnd(12)} ${names.join(', ')}` +
        (dropped.length ? `  (dropped: ${dropped.join(', ')})` : ''),
    );
  }
  await mongoose.disconnect();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
