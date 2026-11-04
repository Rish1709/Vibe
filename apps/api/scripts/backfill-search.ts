/**
 * One-off migration: fills `searchTokens` for accounts created before user search existed.
 *
 *   npm run db:backfill-search -w @vibe/api
 *
 * Safe to re-run and safe while the app is live: it only touches documents still missing the field,
 * in batches, and new writes already set it. Run `db:sync-indexes` too, so the index exists.
 */
import mongoose from 'mongoose';
import { z } from 'zod';
import { UserModel } from '../src/modules/users/user.model.js';
import { searchTokensFor } from '../src/modules/users/user.search.js';

const BATCH_SIZE = 500;

const { MONGODB_URI } = z
  .object({ MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//) })
  .parse(process.env);

async function main() {
  await mongoose.connect(MONGODB_URI, { autoIndex: false });
  let updated = 0;
  for (;;) {
    const batch = await UserModel.find({ searchTokens: { $exists: false } }, { displayName: 1 })
      .limit(BATCH_SIZE)
      .lean<{ _id: mongoose.Types.ObjectId; displayName: string }[]>();
    if (batch.length === 0) break;
    const result = await UserModel.bulkWrite(
      batch.map((user) => ({
        updateOne: {
          // Re-checks the condition, so a concurrent rename's fresh tokens are never overwritten.
          filter: { _id: user._id, searchTokens: { $exists: false } },
          update: { $set: { searchTokens: searchTokensFor(user.displayName) } },
        },
      })),
      { ordered: false },
    );
    updated += result.modifiedCount;
  }
  console.log(`Backfilled search tokens for ${updated} users`);
  await mongoose.disconnect();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
