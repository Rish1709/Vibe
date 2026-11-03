import mongoose from 'mongoose';
import type { Logger } from './logger.js';

interface MongoOptions {
  maxPoolSize: number;
  /** Building indexes on startup is convenient in development but must be a deliberate step in production. */
  autoIndex: boolean;
  logger: Logger;
}

export async function connectMongo(uri: string, { maxPoolSize, autoIndex, logger }: MongoOptions) {
  mongoose.set('strictQuery', true);

  const { connection } = mongoose;
  connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));

  await mongoose.connect(uri, {
    maxPoolSize,
    minPoolSize: Math.min(2, maxPoolSize),
    // Fail fast when the server is unreachable instead of queueing operations for 30s.
    serverSelectionTimeoutMS: 5_000,
    autoIndex,
  });
  logger.info({ maxPoolSize }, 'MongoDB connected');
}

export async function pingMongo(): Promise<void> {
  const { db } = mongoose.connection;
  if (!db) throw new Error('MongoDB is not connected');
  await db.admin().command({ ping: 1 });
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
