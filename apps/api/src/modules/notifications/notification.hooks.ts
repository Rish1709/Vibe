import type { NotificationService } from './notification.service.js';
import type { Notifier } from './notification.queue.js';

/** What social services need to raise and withdraw notifications. */
export interface NotificationHooks {
  notifier: Notifier;
  notifications: Pick<NotificationService, 'retract' | 'retractForComment'>;
}
