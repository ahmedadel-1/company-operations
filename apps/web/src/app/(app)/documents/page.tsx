'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, Label, NativeSelect, Textarea } from '@company-ops/ui/components/input';

import {
  ActionDialog,
  CorporateDocumentList,
  DownloadButton,
  Facts,
  SelectField,
  ValidityBadge,
  VersionUpload,
  useCommercialPerson,
} from '../../../components/commercial';
import { EmployeePicker } from '../../../components/employee-picker';
import type { PickedEmployee } from '../../../components/employee-picker';
import { Field, FormError, fieldErrorsOf } from '../../../components/form';
import { LinkedFilterNotice, WithLinkParams } from '../../../components/linked-filter';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { api, request } from '../../../lib/api';
import {
  CLASSIFICATIONS,
  CORPORATE_DOCUMENT_TYPES,
  VALIDITIES,
  useCommercialAction,
  useCorporateDocument,
  useCorporateDocuments,
} from '../../../lib/commercial';
import type {
  CorporateDocument,
  CorporateDocumentQuery,
  CorporateDocumentType,
  DocumentClassification,
} from '../../../lib/commercial';
import { useDateFormat } from '../../../lib/format';
import { csvOf } from '../../../lib/link-params';
import { useCan } from '../../../lib/session';

export default function DocumentsPage() {
  const t = useTranslations('commercial');
  const can = useCan();
  if (!can('corporate_document.view')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader
        title={t('vault.title')}
        description={t('vault.description')}
        actions={
          can('corporate_document.manage') ? (
            <ActionDialog
              label={t('vault.add')}
              title={t('vault.add')}
              variant="default"
              testId="add-corporate-document"
            >
              {(close) => <CorporateDocumentForm onDone={close} />}
            </ActionDialog>
          ) : undefined
        }
      />
      <WithLinkParams fallback={<ListSkeleton rows={6} />}>{(params) => <Vault params={params} />}</WithLinkParams>
    </>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function initialParams(params: URLSearchParams) {
  const validity = csvOf(params.get('validity'), VALIDITIES);
  const type = csvOf(params.get('type'), CORPORATE_DOCUMENT_TYPES);
  const within = params.get('expiringWithinDays');
  const expiringWithinDays = within !== null && /^\d{1,4}$/.test(within) ? Number.parseInt(within, 10) : undefined;
  const hidden: CorporateDocumentQuery = {
    ...(validity !== undefined && validity.length > 1 ? { validity: validity.join(',') } : {}),
    ...(type !== undefined && type.length > 1 ? { type: type.join(',') } : {}),
    ...(expiringWithinDays === undefined ? {} : { expiringWithinDays }),
  };
  const open = params.get('open');
  return {
    q: params.get('q')?.slice(0, 100) ?? '',
    validity: validity?.length === 1 ? (validity[0] ?? '') : '',
    type: type?.length === 1 ? (type[0] ?? '') : '',
    hidden,
    openId: open !== null && UUID.test(open) ? open : null,
  };
}

function Vault({ params }: { readonly params: URLSearchParams }) {
  const t = useTranslations('commercial');
  const tc = useTranslations('common');
  const [initial] = useState(() => initialParams(params));
  const [draft, setDraft] = useState({
    q: initial.q,
    validity: initial.validity,
    type: initial.type,
    archived: false,
  });
  const [hidden, setHidden] = useState<CorporateDocumentQuery>(initial.hidden);
  const toFilters = (source: typeof draft): CorporateDocumentQuery => {
    const validity = VALIDITIES.find((value) => value === source.validity);
    const type = CORPORATE_DOCUMENT_TYPES.find((value) => value === source.type);
    return {
      status: source.archived ? 'ARCHIVED' : 'ACTIVE',
      ...(source.q.trim() === '' ? {} : { q: source.q.trim() }),
      ...(validity === undefined ? {} : { validity }),
      ...(type === undefined ? {} : { type }),
    };
  };
  const [filters, setFilters] = useState<CorporateDocumentQuery>(() => toFilters(draft));
  const [openId, setOpenId] = useState<string | null>(initial.openId);
  const documents = useCorporateDocuments({ ...hidden, ...filters });
  const rows = documents.data?.pages.flatMap((page) => page.data) ?? [];
  const hiddenParts = [
    hidden.validity === undefined
      ? null
      : hidden.validity
          .split(',')
          .map((value) =>
            VALIDITIES.some((validity) => validity === value) ? t(`validities.${value as 'VALID'}`) : value,
          )
          .join(', '),
    hidden.type === undefined ? null : t('vault.linked.types'),
    hidden.expiringWithinDays === undefined
      ? null
      : t('vault.linked.expiringWithin', { days: hidden.expiringWithinDays }),
  ].filter((part): part is string => part !== null);
  const filtered = Object.keys(filters).some((key) => key !== 'status') || hiddenParts.length > 0;
  const apply = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters(toFilters(draft));
  };
  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={apply}
        role="search"
        aria-label={t('filters')}
        className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
      >
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="vault-q">{t('search')}</Label>
          <Input
            id="vault-q"
            type="search"
            maxLength={100}
            placeholder={t('vault.searchPlaceholder')}
            value={draft.q}
            onChange={(event) => {
              setDraft({ ...draft, q: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vault-validity">{t('fields.validity')}</Label>
          <NativeSelect
            id="vault-validity"
            value={draft.validity}
            onChange={(event) => {
              setDraft({ ...draft, validity: event.target.value });
            }}
          >
            <option value="">{tc('all')}</option>
            {VALIDITIES.map((value) => (
              <option key={value} value={value}>
                {t(`validities.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vault-type">{t('fields.documentType')}</Label>
          <NativeSelect
            id="vault-type"
            value={draft.type}
            onChange={(event) => {
              setDraft({ ...draft, type: event.target.value });
            }}
          >
            <option value="">{tc('all')}</option>
            {CORPORATE_DOCUMENT_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`documentTypes.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.archived}
            onChange={(event) => {
              setDraft({ ...draft, archived: event.target.checked });
            }}
          />
          {t('vault.showArchived')}
        </label>
        <Button type="submit" variant="outline" className="lg:col-start-4">
          {tc('apply')}
        </Button>
      </form>
      {hiddenParts.length === 0 ? null : (
        <LinkedFilterNotice
          description={hiddenParts.join(' · ')}
          onClear={() => {
            setHidden({});
          }}
        />
      )}
      {documents.isPending ? (
        <ListSkeleton />
      ) : documents.isError ? (
        <ErrorState
          error={documents.error}
          onRetry={() => {
            void documents.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState message={filtered ? t('vault.emptyFiltered') : t('vault.empty')} />
      ) : (
        <>
          <CorporateDocumentList documents={rows} label={t('vault.title')} onOpen={setOpenId} />
          {documents.hasNextPage ? (
            <Button
              variant="outline"
              className="self-center"
              disabled={documents.isFetchingNextPage}
              onClick={() => {
                void documents.fetchNextPage();
              }}
            >
              {documents.isFetchingNextPage ? tc('loading') : tc('loadMore')}
            </Button>
          ) : null}
        </>
      )}
      <Dialog
        open={openId !== null}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
      >
        {openId === null ? null : (
          <DialogContent title={t('vault.detail')} closeLabel={tc('close')} className="md:max-w-2xl">
            <DocumentDetail id={openId} />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function DocumentDetail({ id }: { readonly id: string }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const { date, dateTime } = useDateFormat();
  const document = useCorporateDocument(id);
  const action = useCommercialAction();
  const [dates, setDates] = useState({ issueDate: '', expiryDate: '' });
  const [editing, setEditing] = useState(false);
  if (document.isPending) return <ListSkeleton rows={3} />;
  if (document.isError) return <ErrorState error={document.error} />;
  const doc = document.data;
  const archive = (status: 'ACTIVE' | 'ARCHIVED') => {
    action.mutate(() =>
      request(() =>
        api.PATCH('/api/v1/corporate-documents/{id}', {
          params: { path: { id: doc.id } },
          body: { version: doc.version, status },
        }),
      ),
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="corporate-document-detail">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{doc.title}</span>
        <ValidityBadge validity={doc.validity} />
      </div>
      <Facts
        items={[
          [t('fields.documentType'), t(`documentTypes.${doc.documentType}`)],
          doc.documentNumber === null ? null : [t('fields.documentNumber'), doc.documentNumber],
          [t('fields.classification'), t(`classifications.${doc.classification}`)],
          [t('fields.owner'), person(doc.owner)],
          [t('fields.expiryDate'), doc.currentExpiryDate === null ? t('noDate') : date(doc.currentExpiryDate)],
          doc.daysToExpiry === null ? null : [t('fields.daysToExpiry'), t('daysCount', { days: doc.daysToExpiry })],
        ]}
      />
      {doc.notes === null ? null : <p className="text-sm whitespace-pre-wrap">{doc.notes}</p>}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t('vault.versions')}</h3>
        {doc.versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('documents.noVersion')}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="corporate-versions">
            {doc.versions.map((version) => (
              <li
                key={version.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
              >
                <span className="flex flex-col">
                  <span className="font-medium">
                    {t('documents.version', { number: version.versionNumber })}
                    {version.isCurrent ? ` · ${t('vault.current')}` : ''}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {version.filename} · {dateTime(version.uploadedAt)}
                    {version.expiryDate === null ? '' : ` · ${t('fields.expiryDate')}: ${date(version.expiryDate)}`}
                  </span>
                </span>
                <DownloadButton attachmentId={version.attachmentId} filename={version.filename} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {doc.canManage && doc.status === 'ACTIVE' ? (
        <section className="flex flex-col gap-3 rounded-md border border-dashed p-3">
          <h3 className="text-sm font-semibold">{t('vault.addVersion')}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('fields.issueDate')} optional>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={dates.issueDate}
                  onChange={(event) => {
                    setDates({ ...dates, issueDate: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field label={t('fields.expiryDate')} optional>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={dates.expiryDate}
                  onChange={(event) => {
                    setDates({ ...dates, expiryDate: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>
          <VersionUpload
            ownerType="CORPORATE_DOCUMENT"
            ownerId={doc.id}
            label={t('vault.chooseFile')}
            onUploaded={async (attachmentId) => {
              await action.mutateAsync(() =>
                request(() =>
                  api.POST('/api/v1/corporate-documents/{id}/versions', {
                    params: { path: { id: doc.id } },
                    body: {
                      attachmentId,
                      ...(dates.issueDate === '' ? {} : { issueDate: dates.issueDate }),
                      ...(dates.expiryDate === '' ? {} : { expiryDate: dates.expiryDate }),
                    },
                  }),
                ),
              );
              setDates({ issueDate: '', expiryDate: '' });
            }}
          />
        </section>
      ) : null}
      {doc.linkedRequirements.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('vault.usedBy')}</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {doc.linkedRequirements.map((link) => (
              <li key={link.linkId}>
                <Link href={`/tenders/${link.tender.id}#requirements`} className="underline-offset-4 hover:underline">
                  {link.tender.key} · {link.requirement.title}
                </Link>{' '}
                <span className="text-xs text-muted-foreground">
                  ({t('documents.version', { number: link.versionNumber })})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <FormError error={action.error} />
      {doc.canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setEditing(!editing);
            }}
          >
            {t('edit')}
          </Button>
          <Button
            variant="ghost"
            disabled={action.isPending}
            onClick={() => {
              archive(doc.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE');
            }}
          >
            {doc.status === 'ACTIVE' ? t('vault.archive') : t('vault.restore')}
          </Button>
        </div>
      ) : null}
      {editing ? (
        <CorporateDocumentForm
          document={doc}
          onDone={() => {
            setEditing(false);
          }}
        />
      ) : null}
    </div>
  );
}

function CorporateDocumentForm({
  document,
  onDone,
}: {
  readonly document?: CorporateDocument;
  readonly onDone: () => void;
}) {
  const t = useTranslations('commercial');
  const can = useCan();
  const action = useCommercialAction();
  const [type, setType] = useState<CorporateDocumentType | ''>(document?.documentType ?? 'COMMERCIAL_REGISTRATION');
  const [classification, setClassification] = useState<DocumentClassification | ''>(
    document?.classification ?? 'GENERAL',
  );
  const [owner, setOwner] = useState<PickedEmployee | null>(
    document?.owner == null ? null : { id: document.owner.memberId, fullName: document.owner.name },
  );
  const [draft, setDraft] = useState({
    title: document?.title ?? '',
    documentNumber: document?.documentNumber ?? '',
    notes: document?.notes ?? '',
  });
  const errors = fieldErrorsOf(action.error);
  const classifications = CLASSIFICATIONS.filter(
    (value) => value === 'GENERAL' || value === 'COMMERCIAL_CONFIDENTIAL' || can('corporate_document.restricted.view'),
  );
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (type === '') return;
    const fields = {
      documentType: type,
      title: draft.title.trim(),
      documentNumber: draft.documentNumber.trim() === '' ? null : draft.documentNumber.trim(),
      notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
      ownerMemberId: owner?.id ?? null,
      ...(classification === '' ? {} : { classification }),
    };
    action.mutate(
      () =>
        document === undefined
          ? request(() => api.POST('/api/v1/corporate-documents', { body: fields }))
          : request(() =>
              api.PATCH('/api/v1/corporate-documents/{id}', {
                params: { path: { id: document.id } },
                body: { ...fields, version: document.version },
              }),
            ),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="corporate-document-form">
      <FormError error={action.error} />
      <Field label={t('fields.title')} errorCode={errors.get('title')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={300}
            value={draft.title}
            onChange={(event) => {
              setDraft({ ...draft, title: event.target.value });
            }}
          />
        )}
      </Field>
      <SelectField
        label={t('fields.documentType')}
        value={type}
        options={CORPORATE_DOCUMENT_TYPES.map((value) => [value, t(`documentTypes.${value}`)] as const)}
        onChange={setType}
      />
      <SelectField
        label={t('fields.classification')}
        value={classification}
        options={classifications.map((value) => [value, t(`classifications.${value}`)] as const)}
        onChange={setClassification}
      />
      <Field label={t('fields.documentNumber')} optional>
        {(control) => (
          <Input
            {...control}
            maxLength={100}
            value={draft.documentNumber}
            onChange={(event) => {
              setDraft({ ...draft, documentNumber: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('fields.notes')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={5000}
            value={draft.notes}
            onChange={(event) => {
              setDraft({ ...draft, notes: event.target.value });
            }}
          />
        )}
      </Field>
      <EmployeePicker label={t('fields.owner')} value={owner} onChange={setOwner} identity="member" allowNone />
      <p className="text-xs text-muted-foreground">{t('vault.createHint')}</p>
      <Button type="submit" disabled={action.isPending || draft.title.trim() === ''}>
        {action.isPending ? t('saving') : document === undefined ? t('vault.add') : t('save')}
      </Button>
    </form>
  );
}
