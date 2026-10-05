/** BullMQ queues (ARCHITECTURE §3). Processors are added by the phase that owns each queue. */
export const QUEUE_NAMES = [
  'maintenance',
  'notifications',
  'projects',
  'sla',
  'jira-sync',
  'github-sync',
  'requests',
  'attendance',
  'reports',
  'commercial',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];
