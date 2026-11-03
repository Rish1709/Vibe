import type { Logger } from '../infra/logger.js';

export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

interface ShutdownOptions {
  logger: Logger;
  timeoutMs: number;
  /** Run in order. Stop accepting work first, close the data stores last. */
  steps: ShutdownStep[];
}

/**
 * Handles SIGTERM/SIGINT (sent by Docker/Kubernetes before killing the process) and fatal errors.
 * Each step runs even if an earlier one failed; a watchdog forces exit if draining hangs.
 */
export function registerGracefulShutdown({ logger, timeoutMs, steps }: ShutdownOptions): void {
  let shuttingDown = false;

  const shutdown = async (reason: string, initialExitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    let exitCode = initialExitCode;
    logger.info({ reason }, 'Graceful shutdown started');

    const watchdog = setTimeout(() => {
      logger.fatal({ timeoutMs }, 'Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, timeoutMs);
    watchdog.unref();

    for (const step of steps) {
      try {
        await step.run();
        logger.info({ step: step.name }, 'Shutdown step completed');
      } catch (err) {
        exitCode = 1;
        logger.error({ err, step: step.name }, 'Shutdown step failed');
      }
    }

    clearTimeout(watchdog);
    logger.info({ exitCode }, 'Graceful shutdown finished');
    process.exit(exitCode);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.once('SIGINT', () => void shutdown('SIGINT', 0));
  // After an uncaught error the process state is unknown; drain what we can, then exit non-zero.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
}
