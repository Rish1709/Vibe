/** A dependency probe: resolves when the dependency is usable, rejects otherwise. */
export type HealthCheck = () => Promise<void>;

export interface CheckResult {
  status: 'up' | 'down';
  latencyMs: number;
}

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, CheckResult>;
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Health check timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs all probes concurrently, each with its own timeout, so one hung dependency
 * cannot stall the readiness endpoint (which orchestrators poll every few seconds).
 */
export async function checkReadiness(
  checks: Record<string, HealthCheck>,
  timeoutMs: number,
  onFailure: (name: string, err: unknown) => void,
): Promise<ReadinessReport> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, CheckResult]> => {
      const startedAt = performance.now();
      try {
        await withTimeout(check(), timeoutMs);
        return [name, { status: 'up', latencyMs: Math.round(performance.now() - startedAt) }];
      } catch (err) {
        onFailure(name, err);
        return [name, { status: 'down', latencyMs: Math.round(performance.now() - startedAt) }];
      }
    }),
  );
  return {
    ready: entries.every(([, result]) => result.status === 'up'),
    checks: Object.fromEntries(entries),
  };
}
