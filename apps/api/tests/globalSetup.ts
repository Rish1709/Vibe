import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * One in-memory replica set for the whole run (a replica set, so transactions work like production).
 * Each test file connects to its own database on it, so files run in parallel without interference.
 */
export default async function setup(project: TestProject) {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  project.provide('mongoUri', replSet.getUri());
  return async () => {
    await replSet.stop();
  };
}
