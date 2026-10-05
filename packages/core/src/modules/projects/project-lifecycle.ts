import type { ProjectStatus } from '@company-ops/db';

/**
 * Allowed status changes through `PUT /projects/:id/status` (ARCHIVED is reached only through
 * archive/restore). Moving straight from PLANNING to COMPLETED, or re-planning a project that is
 * live, is blocked; a completed project can be reopened (ACTIVE) or moved to MAINTENANCE.
 */
export const STATUS_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> = {
  PLANNING: ['ACTIVE', 'ON_HOLD'],
  ACTIVE: ['ON_HOLD', 'MAINTENANCE', 'COMPLETED'],
  ON_HOLD: ['PLANNING', 'ACTIVE', 'MAINTENANCE', 'COMPLETED'],
  MAINTENANCE: ['ACTIVE', 'ON_HOLD', 'COMPLETED'],
  COMPLETED: ['ACTIVE', 'MAINTENANCE'],
  ARCHIVED: [],
};

/** A project can be archived only when no operational work is running on it. */
export const ARCHIVABLE_STATUSES: readonly ProjectStatus[] = ['PLANNING', 'ON_HOLD', 'COMPLETED'];

/** Status a restored project returns to: a non-operational state from which it can be re-planned or reopened. */
export const RESTORED_STATUS: ProjectStatus = 'ON_HOLD';

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}
