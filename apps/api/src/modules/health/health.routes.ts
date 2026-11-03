import { Router } from 'express';
import { Errors } from '../../lib/errors.js';
import { sendData } from '../../lib/response.js';
import { checkReadiness, type HealthCheck } from './health.service.js';

const CHECK_TIMEOUT_MS = 2_000;

/**
 * - `/live`: the process is up and the event loop is responsive. Never touches dependencies,
 *   so a database outage does not cause the orchestrator to restart healthy API processes.
 * - `/ready`: the process can serve traffic (all dependencies reachable, not draining).
 *   A failing readiness probe only removes the instance from the load balancer.
 */
export function createHealthRouter(checks: Record<string, HealthCheck>): Router {
  const router = Router();

  router.get('/live', (_req, res) => {
    sendData(res, { status: 'ok' });
  });

  router.get('/ready', async (req, res) => {
    const report = await checkReadiness(checks, CHECK_TIMEOUT_MS, (name, err) => {
      req.log.warn({ err, check: name }, 'Readiness check failed');
    });
    if (!report.ready) {
      throw Errors.serviceUnavailable('Service not ready', { checks: report.checks });
    }
    sendData(res, { status: 'ready', checks: report.checks });
  });

  return router;
}
