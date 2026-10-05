'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { NativeSelect, Textarea } from '@company-ops/ui/components/input';

import { api, ApiError, request } from '../lib/api';
import { formFieldErrors, requestKeys, useRequestForm } from '../lib/requests';
import type { RequestDetail } from '../lib/requests';
import { EmployeePicker } from './employee-picker';
import type { PickedEmployee } from './employee-picker';
import { Field, fieldErrorsOf, FormError } from './form';
import { RequestFormFields, toDraft, toFormData } from './request-form';
import type { FormDraft, MemberNames } from './request-form';
import { ErrorState, ListSkeleton } from './states';
import { usePersonName } from './requests';

/** Stores the returned view and refreshes every list it may appear in. */
export function useRequestRefresh() {
  const queryClient = useQueryClient();
  return async (updated: RequestDetail) => {
    queryClient.setQueryData(requestKeys.detail(updated.id), updated);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: requestKeys.lists }),
      queryClient.invalidateQueries({ queryKey: requestKeys.approvals }),
      queryClient.invalidateQueries({ queryKey: requestKeys.history(updated.id) }),
    ]);
  };
}

/** A stale `version` means someone else changed the request: reload it so the user sees the current state. */
function useConflictReload(requestId: string) {
  const queryClient = useQueryClient();
  return (error: unknown) => {
    if (error instanceof ApiError && (error.code === 'VERSION_CONFLICT' || error.code === 'REQUEST_ALREADY_DECIDED')) {
      void queryClient.invalidateQueries({ queryKey: requestKeys.detail(requestId) });
      void queryClient.invalidateQueries({ queryKey: requestKeys.approvals });
    }
  };
}

export function DecisionForm({
  requestId,
  approvalId,
  decision,
  onDone,
}: {
  readonly requestId: string;
  readonly approvalId: string;
  readonly decision: 'approve' | 'reject';
  readonly onDone: (updated: RequestDetail) => void;
}) {
  const t = useTranslations();
  const refresh = useRequestRefresh();
  const reload = useConflictReload(requestId);
  const [comment, setComment] = useState('');
  const required = decision === 'reject';
  const decide = useMutation({
    mutationFn: async () => {
      const body = comment.trim() === '' ? {} : { comment: comment.trim() };
      return (
        await request(() =>
          decision === 'approve'
            ? api.POST('/api/v1/approvals/{approvalId}/approve', { params: { path: { approvalId } }, body })
            : api.POST('/api/v1/approvals/{approvalId}/reject', {
                params: { path: { approvalId } },
                body: { comment: comment.trim() },
              }),
        )
      ).data;
    },
    onSuccess: async (updated) => {
      await refresh(updated);
      onDone(updated);
    },
    onError: reload,
  });
  const errors = fieldErrorsOf(decide.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    decide.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid={`${decision}-form`}>
      <FormError error={decide.error} />
      <Field
        label={required ? t('requests.decision.reason') : t('requests.decision.comment')}
        hint={required ? t('requests.decision.reasonHint') : t('requests.decision.commentHint')}
        errorCode={errors.get('comment')}
        optional={!required}
      >
        {(control) => (
          <Textarea
            {...control}
            name="comment"
            rows={4}
            maxLength={2000}
            required={required}
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
            }}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant={decision === 'reject' ? 'destructive' : 'default'}
        disabled={decide.isPending || (required && comment.trim() === '')}
      >
        {decide.isPending
          ? t('common.saving')
          : decision === 'approve'
            ? t('requests.decision.approve')
            : t('requests.decision.reject')}
      </Button>
    </form>
  );
}

export function CancelForm({
  request: current,
  reasonRequired,
  onDone,
}: {
  readonly request: RequestDetail;
  readonly reasonRequired: boolean;
  readonly onDone: () => void;
}) {
  const t = useTranslations();
  const refresh = useRequestRefresh();
  const reload = useConflictReload(current.id);
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: async () =>
      (
        await request(() =>
          api.POST('/api/v1/requests/{id}/cancel', {
            params: { path: { id: current.id } },
            body: { version: current.version, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) },
          }),
        )
      ).data,
    onSuccess: async (updated) => {
      await refresh(updated);
      onDone();
    },
    onError: reload,
  });
  const errors = fieldErrorsOf(cancel.error);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        cancel.mutate();
      }}
      className="flex flex-col gap-4"
    >
      <FormError error={cancel.error} />
      <p className="text-sm text-muted-foreground">{t('requests.cancel.body')}</p>
      <Field label={t('requests.cancel.reason')} errorCode={errors.get('reason')} optional={!reasonRequired}>
        {(control) => (
          <Textarea
            {...control}
            name="reason"
            rows={3}
            maxLength={1000}
            required={reasonRequired}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="destructive"
        disabled={cancel.isPending || (reasonRequired && reason.trim() === '')}
      >
        {cancel.isPending ? t('common.saving') : t('requests.cancel.confirm')}
      </Button>
    </form>
  );
}

export function FulfilForm({
  request: current,
  action,
  onDone,
}: {
  readonly request: RequestDetail;
  readonly action: 'START' | 'COMPLETE_STEP';
  readonly onDone: () => void;
}) {
  const t = useTranslations();
  const refresh = useRequestRefresh();
  const reload = useConflictReload(current.id);
  const [note, setNote] = useState('');
  const fulfil = useMutation({
    mutationFn: async () =>
      (
        await request(() =>
          api.POST('/api/v1/requests/{id}/fulfillment', {
            params: { path: { id: current.id } },
            body: { version: current.version, action, ...(note.trim() === '' ? {} : { note: note.trim() }) },
          }),
        )
      ).data,
    onSuccess: async (updated) => {
      await refresh(updated);
      onDone();
    },
    onError: reload,
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        fulfil.mutate();
      }}
      className="flex flex-col gap-4"
    >
      <FormError error={fulfil.error} />
      <Field label={t('requests.fulfillment.note')} optional>
        {(control) => (
          <Textarea
            {...control}
            name="note"
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        )}
      </Field>
      <Button type="submit" disabled={fulfil.isPending}>
        {fulfil.isPending ? t('common.saving') : t(`requests.fulfillment.${action}`)}
      </Button>
    </form>
  );
}

export function ReassignForm({
  request: current,
  onDone,
}: {
  readonly request: RequestDetail;
  readonly onDone: () => void;
}) {
  const t = useTranslations();
  const person = usePersonName();
  const refresh = useRequestRefresh();
  const reload = useConflictReload(current.id);
  const active = current.steps.find((step) => step.state === 'ACTIVE');
  const pending = active?.approvals.filter((approval) => approval.status === 'PENDING') ?? [];
  const [member, setMember] = useState<PickedEmployee | null>(null);
  const [replace, setReplace] = useState(pending[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const reassign = useMutation({
    mutationFn: async () =>
      (
        await request(() =>
          api.POST('/api/v1/requests/{id}/reassign', {
            params: { path: { id: current.id } },
            body: {
              version: current.version,
              memberId: member?.id ?? '',
              reason: reason.trim(),
              ...(replace === '' ? {} : { replaceApprovalId: replace }),
            },
          }),
        )
      ).data,
    onSuccess: async (updated) => {
      await refresh(updated);
      onDone();
    },
    onError: reload,
  });
  const errors = fieldErrorsOf(reassign.error);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        reassign.mutate();
      }}
      className="flex flex-col gap-4"
    >
      <FormError error={reassign.error} />
      <EmployeePicker label={t('requests.reassign.member')} identity="member" value={member} onChange={setMember} />
      <Field label={t('requests.reassign.replace')} errorCode={errors.get('replaceApprovalId')}>
        {(control) => (
          <NativeSelect
            {...control}
            value={replace}
            onChange={(event) => {
              setReplace(event.target.value);
            }}
          >
            <option value="">{t('requests.reassign.addAssignee')}</option>
            {pending.map((approval) => (
              <option key={approval.id} value={approval.id}>
                {t('requests.reassign.replacePerson', { name: person(approval.approver) })}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label={t('requests.reassign.reason')} errorCode={errors.get('reason')}>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={500}
            required
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        )}
      </Field>
      <Button type="submit" disabled={reassign.isPending || member === null || reason.trim() === ''}>
        {reassign.isPending ? t('common.saving') : t('requests.reassign.confirm')}
      </Button>
    </form>
  );
}

/** Draft editing against the type's current published form (saving re-binds the draft to it). */
export function DraftEditor({
  request: current,
  onDone,
}: {
  readonly request: RequestDetail;
  readonly onDone: () => void;
}) {
  const t = useTranslations();
  const form = useRequestForm(current.requestType.id);
  if (form.isPending) return <ListSkeleton rows={3} />;
  if (form.isError) {
    return (
      <ErrorState
        error={form.error}
        onRetry={() => {
          void form.refetch();
        }}
      />
    );
  }
  return (
    <DraftEditorForm
      key={form.data.workflowVersionId}
      request={current}
      schema={form.data.form}
      outdated={form.data.workflowVersionId !== current.workflowVersion.id}
      onDone={onDone}
      cancelLabel={t('common.cancel')}
    />
  );
}

function DraftEditorForm({
  request: current,
  schema,
  outdated,
  onDone,
  cancelLabel,
}: {
  readonly request: RequestDetail;
  readonly schema: RequestDetail['form'];
  readonly outdated: boolean;
  readonly onDone: () => void;
  readonly cancelLabel: string;
}) {
  const t = useTranslations();
  const refresh = useRequestRefresh();
  const reload = useConflictReload(current.id);
  const [draft, setDraft] = useState<FormDraft>(() => toDraft(current.formData));
  const [memberNames, setMemberNames] = useState<MemberNames>(() =>
    Object.fromEntries(current.references.members.map((member) => [member.memberId, member.name])),
  );
  const save = useMutation({
    mutationFn: async () =>
      (
        await request(() =>
          api.PATCH('/api/v1/requests/{id}', {
            params: { path: { id: current.id } },
            body: { version: current.version, formData: toFormData(schema, draft) },
          }),
        )
      ).data,
    onSuccess: async (updated) => {
      await refresh(updated);
      onDone();
    },
    onError: reload,
  });
  const errors = formFieldErrors(save.error instanceof ApiError ? save.error.fieldErrors : []);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
      className="flex flex-col gap-4"
      noValidate
      data-testid="draft-editor"
    >
      {outdated ? (
        <p role="status" className="rounded-md border p-3 text-sm">
          {t('requests.detail.formUpdated')}
        </p>
      ) : null}
      <FormError error={save.error} />
      <RequestFormFields
        schema={schema}
        draft={draft}
        onChange={setDraft}
        errors={errors}
        memberNames={memberNames}
        onMemberName={(id, name) => {
          setMemberNames((names) => ({ ...names, [id]: name }));
        }}
        disabled={save.isPending}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t('common.saving') : t('requests.detail.saveDraft')}
        </Button>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          {cancelLabel}
        </Button>
      </div>
    </form>
  );
}
