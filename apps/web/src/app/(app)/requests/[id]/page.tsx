'use client';

import { useMutation } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';

import { FormError, StatusMessage } from '../../../../components/form';
import { Attachments } from '../../../../components/report-attachments';
import {
  CancelForm,
  DecisionForm,
  DraftEditor,
  FulfilForm,
  ReassignForm,
  useRequestRefresh,
} from '../../../../components/request-actions';
import {
  FormDataView,
  RequestHistory,
  RequestStatusBadge,
  RequestTypeIconView,
  StepTimeline,
  useDateSpan,
  usePersonName,
} from '../../../../components/requests';
import { ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, ApiError, request } from '../../../../lib/api';
import { useDateFormat } from '../../../../lib/format';
import { REQUEST_ATTACHMENT_TYPES, useLocalized, useRequest } from '../../../../lib/requests';
import type { RequestDetail } from '../../../../lib/requests';
import { useCan, useSession } from '../../../../lib/session';

export default function RequestPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const detail = useRequest(id);
  if (!can('request.view') && !can('request.create') && !can('request.approve')) {
    return <Forbidden />;
  }
  if (detail.isPending) return <ListSkeleton rows={6} />;
  if (detail.isError) {
    return (
      <ErrorState
        error={detail.error}
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  }
  return <RequestView request={detail.data} />;
}

type ActionDialog =
  | { readonly kind: 'approve' | 'reject'; readonly approvalId: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'fulfil'; readonly action: 'START' | 'COMPLETE_STEP' }
  | { readonly kind: 'reassign' };

function RequestView({ request: current }: { readonly request: RequestDetail }) {
  const t = useTranslations();
  const me = useSession();
  const localized = useLocalized();
  const person = usePersonName();
  const { dateTime } = useDateFormat();
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<ActionDialog | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const dialogTitle = useDialogTitle();
  const finish = (message: string) => {
    setDialog(null);
    setDone(message);
  };
  const title = localized(current.requestType.name);

  return (
    <>
      <PageHeader
        title={`${current.key} · ${title}`}
        description={t('requests.detail.requestedBy', {
          name: person(current.requester),
          date: dateTime(current.submittedAt ?? current.createdAt),
        })}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RequestStatusBadge status={current.status} />
        <Badge>
          <RequestTypeIconView icon={current.requestType.icon} className="size-3" />
          {t(`requests.categories.${current.requestType.category}`)}
        </Badge>
        <Badge data-testid="workflow-version">
          {t('requests.detail.workflowVersion', { number: current.workflowVersion.number })}
        </Badge>
      </div>
      {current.status === 'CANCELLED' && current.cancelReason !== null ? (
        <p className="mb-4 rounded-md border p-3 text-sm" data-testid="cancel-reason">
          {t('requests.detail.cancelledBecause', { reason: current.cancelReason })}
        </p>
      ) : null}
      <ActionBar
        request={current}
        editing={editing}
        onEdit={() => {
          setEditing(true);
        }}
        onDialog={(next) => {
          setDone(null);
          setDialog(next);
        }}
        onDone={setDone}
      />
      {done === null ? null : (
        <div className="mb-4">
          <StatusMessage>{done}</StatusMessage>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('requests.detail.details')}</CardTitle>
            </CardHeader>
            <CardContent>
              {editing && current.access.canEdit ? (
                <DraftEditor
                  request={current}
                  onDone={() => {
                    setEditing(false);
                  }}
                />
              ) : (
                <FormDataView
                  fields={current.form.fields}
                  data={current.formData}
                  memberNames={Object.fromEntries(
                    current.references.members.map((member) => [member.memberId, person(member)]),
                  )}
                  projectNames={Object.fromEntries(
                    current.references.projects.map((project) => [project.id, `${project.code} · ${project.name}`]),
                  )}
                />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('requests.detail.route')}</CardTitle>
            </CardHeader>
            <CardContent>
              {current.status === 'DRAFT' ? (
                <p className="text-sm text-muted-foreground">{t('requests.detail.routeAfterSubmit')}</p>
              ) : (
                <StepTimeline request={current} />
              )}
            </CardContent>
          </Card>
          <RequestHistory requestId={current.id} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <SummaryCard request={current} />
          {current.attachments.requirement !== 'NONE' ? (
            <Card>
              <CardContent>
                <Attachments
                  ownerType="REQUEST"
                  ownerId={current.id}
                  allowedTypes={REQUEST_ATTACHMENT_TYPES}
                  hint={t('requests.attachments.hint', { max: current.attachments.maxFiles })}
                  badType={t('requests.attachments.badType')}
                  testId="request-attachments"
                  canUpload={current.access.canAttach}
                  canDelete={current.access.canEdit}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        {dialog === null ? null : (
          <DialogContent title={`${dialogTitle(dialog)} · ${current.key}`} closeLabel={t('common.close')}>
            {dialog.kind === 'approve' || dialog.kind === 'reject' ? (
              <DecisionForm
                requestId={current.id}
                approvalId={dialog.approvalId}
                decision={dialog.kind}
                onDone={() => {
                  finish(dialog.kind === 'approve' ? t('requests.decision.approved') : t('requests.decision.rejected'));
                }}
              />
            ) : dialog.kind === 'cancel' ? (
              <CancelForm
                request={current}
                reasonRequired={current.requester.memberId !== me.activeOrganization.memberId}
                onDone={() => {
                  finish(t('requests.cancel.done'));
                }}
              />
            ) : dialog.kind === 'fulfil' ? (
              <FulfilForm
                request={current}
                action={dialog.action}
                onDone={() => {
                  finish(t('requests.fulfillment.done'));
                }}
              />
            ) : (
              <ReassignForm
                request={current}
                onDone={() => {
                  finish(t('requests.reassign.done'));
                }}
              />
            )}
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function useDialogTitle(): (dialog: ActionDialog) => string {
  const t = useTranslations();
  return (dialog) => {
    switch (dialog.kind) {
      case 'approve':
        return t('requests.decision.approve');
      case 'reject':
        return t('requests.decision.reject');
      case 'cancel':
        return t('requests.cancel.title');
      case 'fulfil':
        return t(`requests.fulfillment.${dialog.action}`);
      case 'reassign':
        return t('requests.reassign.title');
    }
  };
}

function ActionBar({
  request: current,
  editing,
  onEdit,
  onDialog,
  onDone,
}: {
  readonly request: RequestDetail;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onDialog: (dialog: ActionDialog) => void;
  readonly onDone: (message: string) => void;
}) {
  const t = useTranslations();
  const refresh = useRequestRefresh();
  const access = current.access;
  const approvalId = access.decidableApprovalIds[0];
  const submit = useMutation({
    mutationFn: async () =>
      (
        await request(() =>
          api.POST('/api/v1/requests/{id}/submit', {
            params: { path: { id: current.id } },
            body: { version: current.version },
          }),
        )
      ).data,
    onSuccess: async (updated) => {
      await refresh(updated);
      onDone(t('requests.detail.submitted'));
    },
  });
  const hasActions =
    access.canSubmit ||
    access.canEdit ||
    access.canCancel ||
    approvalId !== undefined ||
    access.fulfillmentAction !== null ||
    access.canReassign;
  if (!hasActions) return null;
  return (
    <section aria-label={t('requests.detail.actions')} className="mb-4 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {approvalId === undefined ? null : (
          <>
            <Button
              data-testid="approve-request"
              onClick={() => {
                onDialog({ kind: 'approve', approvalId });
              }}
            >
              {t('requests.decision.approve')}
            </Button>
            <Button
              variant="outline"
              data-testid="reject-request"
              onClick={() => {
                onDialog({ kind: 'reject', approvalId });
              }}
            >
              {t('requests.decision.reject')}
            </Button>
          </>
        )}
        {access.canSubmit ? (
          <Button
            data-testid="submit-draft"
            disabled={submit.isPending || editing}
            onClick={() => {
              submit.mutate();
            }}
          >
            {submit.isPending ? t('requests.create.submitting') : t('requests.create.submit')}
          </Button>
        ) : null}
        {access.canEdit && !editing ? (
          <Button variant="outline" onClick={onEdit}>
            {t('requests.detail.edit')}
          </Button>
        ) : null}
        {access.fulfillmentAction === null ? null : (
          <Button
            data-testid="fulfil-request"
            onClick={() => {
              if (access.fulfillmentAction !== null) onDialog({ kind: 'fulfil', action: access.fulfillmentAction });
            }}
          >
            {t(`requests.fulfillment.${access.fulfillmentAction}`)}
          </Button>
        )}
        {access.canReassign ? (
          <Button
            variant="outline"
            onClick={() => {
              onDialog({ kind: 'reassign' });
            }}
          >
            {t('requests.reassign.title')}
          </Button>
        ) : null}
        {access.canCancel ? (
          <Button
            variant="outline"
            data-testid="cancel-request"
            onClick={() => {
              onDialog({ kind: 'cancel' });
            }}
          >
            {t('requests.cancel.title')}
          </Button>
        ) : null}
      </div>
      {submit.error instanceof ApiError && submit.error.code === 'REQUEST_FORM_OUTDATED' ? (
        <p role="alert" className="text-sm text-destructive">
          {t('requests.detail.formOutdated')}
        </p>
      ) : (
        <FormError error={submit.error} />
      )}
    </section>
  );
}

function SummaryCard({ request: current }: { readonly request: RequestDetail }) {
  const t = useTranslations('requests');
  const me = useSession();
  const localized = useLocalized();
  const person = usePersonName();
  const span = useDateSpan();
  const { dateTime } = useDateFormat();
  const rows: [string, string][] = [
    [t('type'), localized(current.requestType.name)],
    [
      t('requester'),
      current.requester.memberId === me.activeOrganization.memberId ? t('detail.you') : person(current.requester),
    ],
  ];
  if (current.project !== null) rows.push([t('project'), `${current.project.code} · ${current.project.name}`]);
  const dates = span(current.startsOn, current.endsOn);
  if (dates !== null) rows.push([t('dates'), dates]);
  if (current.currentStep !== null) rows.push([t('currentStep'), localized(current.currentStep.name)]);
  if (current.submittedAt !== null) rows.push([t('submittedAt'), dateTime(current.submittedAt)]);
  if (current.decidedAt !== null) rows.push([t('decidedAt'), dateTime(current.decidedAt)]);
  if (current.completedAt !== null) rows.push([t('completedAt'), dateTime(current.completedAt)]);
  if (current.cancelledAt !== null) rows.push([t('cancelledAt'), dateTime(current.cancelledAt)]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('detail.summary')}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
