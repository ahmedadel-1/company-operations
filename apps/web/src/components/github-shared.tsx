'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, ExternalLinkIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';

import { api, request } from '../lib/api';
import { useDateFormat } from '../lib/format';
import { githubKeys } from '../lib/github';
import type { GithubPull, GithubPrJiraLink, GithubPullSignal } from '../lib/github';
import { FormError } from './form';
import { JiraIssueLink } from './ticket-jira-panel';

export function useGithubErrorCode(): (code: string | null) => string | null {
  const t = useTranslations('github.errorCodes');
  return (code) => {
    if (code === null) {
      return null;
    }
    return t.has(code as 'generic') ? t(code as 'generic') : t('generic');
  };
}

/** Opens the pull request on GitHub in a new tab; the accessible name says so. */
export function PullLink({ pull }: { readonly pull: Pick<GithubPull, 'url' | 'number' | 'repository'> }) {
  const t = useTranslations('github');
  return (
    <a
      href={pull.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-6 items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
      aria-label={t('openOnGithub', { repository: pull.repository.fullName, number: pull.number })}
    >
      {pull.repository.fullName}#{pull.number}
      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
    </a>
  );
}

const SIGNAL_TONE: Record<GithubPullSignal, 'neutral' | 'warning' | 'danger'> = {
  DRAFT: 'neutral',
  AWAITING_REVIEW: 'warning',
  CHANGES_REQUESTED: 'warning',
  FAILING_CHECKS: 'danger',
  STALE_SYNC: 'neutral',
};

export function PullStateBadges({ pull }: { readonly pull: GithubPull }) {
  const t = useTranslations('github');
  const stateTone = { OPEN: 'success', CLOSED: 'neutral', MERGED: 'neutral' } as const;
  const reviewTone = {
    NONE: 'neutral',
    REVIEW_REQUIRED: 'warning',
    CHANGES_REQUESTED: 'warning',
    APPROVED: 'success',
  } as const;
  const checksTone = { UNKNOWN: 'neutral', PENDING: 'warning', SUCCESS: 'success', FAILURE: 'danger' } as const;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={stateTone[pull.state]}>{t(`pullStates.${pull.state}`)}</Badge>
      {pull.draft ? <Badge>{t('draft')}</Badge> : null}
      {pull.state === 'OPEN' ? (
        <>
          <Badge tone={reviewTone[pull.reviewState]}>
            <span className="sr-only">{t('reviewLabel')}: </span>
            {t(`reviewStates.${pull.reviewState}`)}
          </Badge>
          <Badge tone={checksTone[pull.checksState]}>
            <span className="sr-only">{t('checksLabel')}: </span>
            {t(`checksStates.${pull.checksState}`)}
            {pull.checksTotal > 0
              ? ` (${String(pull.checksTotal - pull.checksPending - pull.checksFailed)}/${String(pull.checksTotal)})`
              : ''}
          </Badge>
        </>
      ) : null}
    </span>
  );
}

export function PullSignals({ signals }: { readonly signals: readonly GithubPullSignal[] }) {
  const t = useTranslations('github.signals');
  const shown = signals.filter((signal) => signal !== 'DRAFT');
  if (shown.length === 0) {
    return null;
  }
  return (
    <span className="inline-flex flex-wrap gap-1" data-testid="pull-signals">
      {shown.map((signal) => (
        <Badge key={signal} tone={SIGNAL_TONE[signal]}>
          {t(signal)}
        </Badge>
      ))}
    </span>
  );
}

function JiraLinkRow({
  link,
  projectId,
  canDecide,
  onDecided,
}: {
  readonly link: GithubPrJiraLink;
  readonly projectId: string | null;
  readonly canDecide: boolean;
  readonly onDecided: () => Promise<unknown>;
}) {
  const t = useTranslations('github');
  const decide = useMutation({
    mutationFn: (decision: 'confirm' | 'dismiss') =>
      request(() =>
        decision === 'confirm'
          ? api.POST('/api/v1/projects/{id}/github/jira-links/{linkId}/confirm', {
              params: { path: { id: projectId ?? '', linkId: link.id } },
            })
          : api.POST('/api/v1/projects/{id}/github/jira-links/{linkId}/dismiss', {
              params: { path: { id: projectId ?? '', linkId: link.id } },
            }),
      ),
    onSuccess: onDecided,
  });
  const suggested = link.state === 'SUGGESTED';
  return (
    <li className="flex flex-wrap items-center gap-2" data-testid="pull-jira-link" data-state={link.state}>
      <JiraIssueLink issue={link.issue} />
      <span className="min-w-0 break-words text-muted-foreground">{link.issue.summary}</span>
      <Badge tone={suggested ? 'warning' : 'success'}>
        {suggested ? t('jira.suggested') : t('jira.confirmed')}
        <span className="sr-only"> ({t(`jira.sources.${link.source}`)})</span>
      </Badge>
      {suggested && canDecide && projectId !== null ? (
        <span className="inline-flex gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={decide.isPending}
            aria-label={t('jira.confirmLabel', { key: link.issue.key })}
            onClick={() => {
              decide.mutate('confirm');
            }}
          >
            <CheckIcon aria-hidden="true" />
            {t('jira.confirm')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={decide.isPending}
            aria-label={t('jira.dismissLabel', { key: link.issue.key })}
            onClick={() => {
              decide.mutate('dismiss');
            }}
          >
            <XIcon aria-hidden="true" />
            {t('jira.dismiss')}
          </Button>
        </span>
      ) : null}
      <FormError error={decide.error} />
    </li>
  );
}

/**
 * One pull request from the local cache: identity, state, review and check summary, operational
 * signals and Jira associations. Unverified keys are shown as text only (never as issue links).
 */
export function PullItem({
  pull,
  projectId,
  canDecide,
  actions,
}: {
  readonly pull: GithubPull;
  /** Project whose tab shows the item (needed to confirm/dismiss suggestions); null elsewhere. */
  readonly projectId: string | null;
  readonly canDecide: boolean;
  readonly actions?: ReactNode;
}) {
  const t = useTranslations('github');
  const { dateTime } = useDateFormat();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: githubKeys.all });
  return (
    <li
      className="flex flex-col gap-2 rounded-md border p-3 text-sm"
      data-testid="github-pull"
      data-number={pull.number}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PullLink pull={pull} />
        <PullStateBadges pull={pull} />
      </div>
      <p className="break-words font-medium">{pull.title}</p>
      <p className="text-xs text-muted-foreground">
        {pull.authorLogin === null ? '' : `${pull.authorLogin} · `}
        <span dir="ltr">
          {pull.headRef} → {pull.baseRef}
        </span>
        {' · '}
        {t('updatedAt', { date: dateTime(pull.ghUpdatedAt) })}
      </p>
      <PullSignals signals={pull.signals} />
      {pull.jiraLinks.length === 0 && pull.unverifiedKeys.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          {pull.jiraLinks.length === 0 ? null : (
            <ul className="flex flex-col gap-1" aria-label={t('jira.linked')}>
              {pull.jiraLinks.map((link) => (
                <JiraLinkRow
                  key={link.id}
                  link={link}
                  projectId={projectId}
                  canDecide={canDecide}
                  onDecided={refresh}
                />
              ))}
            </ul>
          )}
          {pull.unverifiedKeys.length === 0 ? null : (
            <p className="text-xs text-muted-foreground" data-testid="pull-unverified-keys">
              {t('jira.unverified', { keys: pull.unverifiedKeys.join(', ') })}
            </p>
          )}
        </div>
      )}
      {actions}
    </li>
  );
}
