import { pino, type Logger, type LevelWithSilent } from 'pino';

export type { Logger };

interface LoggerOptions {
  level: LevelWithSilent;
  pretty: boolean;
}

export function createLogger({ level, pretty }: LoggerOptions): Logger {
  return pino({
    level,
    base: { service: 'vibe-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Credentials must never reach log storage.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
    ...(pretty && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
        },
      },
    }),
  });
}
