import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';
import { connectMongo, disconnectMongo } from '../../src/infra/mongo.js';
import { silentLogger } from './testApp.js';

/**
 * Connects this test file to its own database on the shared replica set and builds indexes.
 * By default every test starts empty; `scope: 'file'` keeps data across the file's tests, for suites
 * that build one expensive fixture in `beforeAll` and only read or attempt changes afterwards.
 */
export function useTestDatabase({ scope = 'test' }: { scope?: 'test' | 'file' } = {}): void {
  beforeAll(async () => {
    const uri = new URL(inject('mongoUri'));
    uri.pathname = `/test_${randomUUID().slice(0, 8)}`;
    await connectMongo(uri.toString(), { maxPoolSize: 10, autoIndex: true, logger: silentLogger });
    // Unique-index tests are meaningless until the indexes exist.
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  });

  beforeEach(async () => {
    if (scope === 'file') return;
    const collections = await mongoose.connection.db?.collections();
    // system.* (e.g. the profiler's output) belongs to MongoDB and can't be written to.
    await Promise.all(
      (collections ?? [])
        .filter((collection) => !collection.collectionName.startsWith('system.'))
        .map((collection) => collection.deleteMany({})),
    );
  });

  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await disconnectMongo();
  });
}

/**
 * Real Redis from docker-compose (`npm run infra:up`), on a separate logical database so tests never
 * touch development data. Keys in tests are unique per run (random ids), so no flushing is needed.
 */
export function useTestRedis(): Redis {
  const redis = new Redis(process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/15', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  beforeAll(async () => {
    await redis.connect();
  });
  afterAll(async () => {
    await redis.quit();
  });
  return redis;
}
