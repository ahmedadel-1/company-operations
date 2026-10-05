'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { dashboardKeys } from './dashboard';
import { githubKeys } from './github';
import { jiraKeys } from './jira';
import { queryKeys } from './queries';
import { requestKeys } from './requests';
import { supportKeys } from './support';

const STREAM_URL = '/api/v1/notifications/events/stream';
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

interface ChangeEvent {
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
}

function parseChange(data: unknown): ChangeEvent | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const { type, entityType, entityId } = value as Record<string, unknown>;
    return typeof type === 'string' && typeof entityType === 'string' && typeof entityId === 'string'
      ? { type, entityType, entityId }
      : null;
  } catch {
    return null;
  }
}

/**
 * Opens the live-update stream and keeps it open: a CLOSED stream (session ended, too many
 * streams, network loss) is reopened with exponential backoff. Returns the unsubscribe function.
 */
function subscribe(onChange: (change: ChangeEvent) => void): () => void {
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = FIRST_RETRY_MS;
  let stopped = false;

  const onReady = () => {
    delay = FIRST_RETRY_MS;
  };
  const onMessage = (event: MessageEvent) => {
    const change = parseChange(event.data);
    if (change !== null) {
      onChange(change);
    }
  };
  const disconnect = () => {
    if (source !== null) {
      source.removeEventListener('ready', onReady);
      source.removeEventListener('change', onMessage);
      source.onerror = null;
      source.close();
      source = null;
    }
  };
  const connect = () => {
    if (stopped) {
      return;
    }
    source = new EventSource(STREAM_URL, { withCredentials: true });
    source.addEventListener('ready', onReady);
    source.addEventListener('change', onMessage);
    source.onerror = () => {
      // The browser retries transient drops itself; a CLOSED stream needs a new connection.
      if (source?.readyState === EventSource.CLOSED) {
        disconnect();
        retryTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, MAX_RETRY_MS);
      }
    };
  };

  connect();
  return () => {
    stopped = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
    }
    disconnect();
  };
}

/**
 * Live updates (ADR-0011): events are hints only ("notification created", "ticket changed"), so the
 * client re-fetches through the authorized API. Without the stream the unread-count polling still works.
 */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      return;
    }
    return subscribe((change) => {
      // Every hint may move a dashboard number; the worker retires the server cache before publishing.
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      if (change.entityType === 'notification') {
        void queryClient.invalidateQueries({ queryKey: ['notifications'] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.unreadCount });
      } else if (change.entityType === 'support_ticket') {
        void queryClient.invalidateQueries({ queryKey: supportKeys.ticket(change.entityId) });
        void queryClient.invalidateQueries({ queryKey: ['support', 'tickets'] });
        void queryClient.invalidateQueries({ queryKey: ['support', 'project'] });
        void queryClient.invalidateQueries({ queryKey: jiraKeys.ticket(change.entityId) });
        void queryClient.invalidateQueries({ queryKey: githubKeys.ticket(change.entityId) });
      } else if (change.entityType === 'request') {
        void queryClient.invalidateQueries({ queryKey: requestKeys.detail(change.entityId) });
        void queryClient.invalidateQueries({ queryKey: requestKeys.lists });
        void queryClient.invalidateQueries({ queryKey: requestKeys.approvals });
      } else if (change.entityType === 'jira_sync_run') {
        void queryClient.invalidateQueries({ queryKey: ['jira', 'runs'] });
        void queryClient.invalidateQueries({ queryKey: jiraKeys.run(change.entityId) });
        void queryClient.invalidateQueries({ queryKey: jiraKeys.mappings });
      } else if (change.entityType === 'github_sync_run') {
        void queryClient.invalidateQueries({ queryKey: githubKeys.runsAll });
        void queryClient.invalidateQueries({ queryKey: githubKeys.run(change.entityId) });
        void queryClient.invalidateQueries({ queryKey: githubKeys.repositoriesAll });
      }
    });
  }, [queryClient]);
}
