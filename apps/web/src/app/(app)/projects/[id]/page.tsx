'use client';

import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { CommercialTab } from '../../../../components/project-commercial-tab';
import { GithubTab } from '../../../../components/project-github-tab';
import { JiraTab } from '../../../../components/project-jira-tab';
import { SupportTab } from '../../../../components/project-support-tab';
import { ActivityTab, OverviewTab, ReportsTab, SettingsTab, TeamTab } from '../../../../components/project-tabs';
import { ProjectHealthBadge, ProjectStatusBadge } from '../../../../components/projects';
import { ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { useProject } from '../../../../lib/projects';
import type { Project } from '../../../../lib/projects';
import { useCan } from '../../../../lib/session';

const TABS = [
  'overview',
  'team',
  'reports',
  'support',
  'jira',
  'github',
  'commercial',
  'activity',
  'settings',
] as const;
type Tab = (typeof TABS)[number];

function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value);
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const project = useProject(id);
  if (!can('project.view')) {
    return <Forbidden />;
  }
  if (project.isPending) {
    return <ListSkeleton rows={5} />;
  }
  if (project.isError) {
    return (
      <ErrorState
        error={project.error}
        onRetry={() => {
          void project.refetch();
        }}
      />
    );
  }
  return <ProjectDetail project={project.data} />;
}

function ProjectDetail({ project }: { readonly project: Project }) {
  const t = useTranslations();
  const can = useCan();
  const visible = TABS.filter((tab) => {
    if (tab === 'reports') {
      return project.access.canViewReports || project.access.canSubmitReports;
    }
    if (tab === 'support') {
      return can('support.view');
    }
    if (tab === 'jira') {
      return can('jira.view');
    }
    if (tab === 'github') {
      return can('github.view');
    }
    if (tab === 'commercial') {
      return can('tender.view') || can('contract.view');
    }
    if (tab === 'settings') {
      return project.access.canManage || project.access.canArchive;
    }
    return true;
  });
  // Rendered only after the project loaded on the client, so the initial hash can be read here.
  const [tab, setTab] = useState<Tab>(() => {
    const fromHash = typeof window === 'undefined' ? '' : window.location.hash.replace('#', '');
    return isTab(fromHash) && visible.includes(fromHash) ? fromHash : 'overview';
  });
  const tabButtonsRef = useRef(new Map<Tab, HTMLButtonElement>());

  const select = (next: Tab) => {
    setTab(next);
    window.history.replaceState(null, '', `#${next}`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = visible.indexOf(tab);
    const rtl = document.documentElement.dir === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: Tab | undefined;
    if (event.key === forward) {
      next = visible[(index + 1) % visible.length];
    } else if (event.key === backward) {
      next = visible[(index - 1 + visible.length) % visible.length];
    } else if (event.key === 'Home') {
      next = visible[0];
    } else if (event.key === 'End') {
      next = visible.at(-1);
    }
    if (next !== undefined) {
      event.preventDefault();
      select(next);
      tabButtonsRef.current.get(next)?.focus();
    }
  };

  return (
    <>
      <PageHeader
        title={project.name}
        description={[project.code, project.customer?.name].filter(Boolean).join(' · ')}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <ProjectStatusBadge status={project.status} />
        <ProjectHealthBadge health={project.health} />
      </div>
      <div className="relative mb-6 overflow-x-auto border-b">
        <div role="tablist" aria-label={t('projects.sections')} className="flex min-w-max gap-1" onKeyDown={onKeyDown}>
          {visible.map((key) => (
            <button
              key={key}
              ref={(node) => {
                if (node === null) {
                  tabButtonsRef.current.delete(key);
                } else {
                  tabButtonsRef.current.set(key, node);
                }
              }}
              type="button"
              role="tab"
              id={`tab-${key}`}
              aria-selected={tab === key}
              aria-controls={tab === key ? `panel-${key}` : undefined}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => {
                select(key);
              }}
              className="min-h-11 border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground aria-selected:border-primary aria-selected:text-foreground"
            >
              {t(`projects.tabs.${key}`)}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === 'overview' ? (
          <OverviewTab project={project} />
        ) : tab === 'team' ? (
          <TeamTab project={project} />
        ) : tab === 'reports' ? (
          <ReportsTab project={project} />
        ) : tab === 'support' ? (
          <SupportTab project={project} />
        ) : tab === 'jira' ? (
          <JiraTab project={project} />
        ) : tab === 'github' ? (
          <GithubTab project={project} />
        ) : tab === 'commercial' ? (
          <CommercialTab project={project} />
        ) : tab === 'activity' ? (
          <ActivityTab project={project} />
        ) : (
          <SettingsTab project={project} />
        )}
      </div>
    </>
  );
}
