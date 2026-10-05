'use client';

import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Card } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, Label, NativeSelect } from '@company-ops/ui/components/input';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import { EmployeeForm, EmploymentStatusBadge, InvitationNotice, MemberStatusBadge } from '../../../components/people';
import type { Invitation } from '../../../components/people';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { useDepartments, useEmployees } from '../../../lib/queries';
import type { EmployeeFilters } from '../../../lib/queries';
import { useCan } from '../../../lib/session';

const EMPLOYMENT_STATUSES = ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED'] as const;
const MEMBER_STATUSES = ['INVITED', 'ACTIVE', 'DISABLED'] as const;

export default function PeoplePage() {
  const t = useTranslations();
  const can = useCan();
  if (!can('employee.view')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('people.title')} actions={can('employee.manage') ? <CreateEmployeeButton /> : undefined} />
      <EmployeeDirectory />
    </>
  );
}

function EmployeeDirectory() {
  const t = useTranslations();
  const departments = useDepartments();
  const [draft, setDraft] = useState({ q: '', departmentId: '', employmentStatus: '', memberStatus: '' });
  const [filters, setFilters] = useState<EmployeeFilters>({});
  const employees = useEmployees(filters);
  const rows = employees.data?.pages.flatMap((page) => page.data) ?? [];
  const filtered = Object.keys(filters).length > 0;

  const apply = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const employmentStatus = EMPLOYMENT_STATUSES.find((status) => status === draft.employmentStatus);
    const memberStatus = MEMBER_STATUSES.find((status) => status === draft.memberStatus);
    setFilters({
      ...(draft.q.trim() === '' ? {} : { q: draft.q.trim() }),
      ...(draft.departmentId === '' ? {} : { departmentId: draft.departmentId }),
      ...(employmentStatus === undefined ? {} : { employmentStatus }),
      ...(memberStatus === undefined ? {} : { memberStatus }),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={apply}
        role="search"
        className="grid gap-3 rounded-lg border p-4 md:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto] lg:items-end"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="people-q">{t('people.search')}</Label>
          <Input
            id="people-q"
            type="search"
            placeholder={t('people.searchPlaceholder')}
            value={draft.q}
            onChange={(event) => {
              setDraft({ ...draft, q: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="people-department">{t('people.department')}</Label>
          <NativeSelect
            id="people-department"
            value={draft.departmentId}
            onChange={(event) => {
              setDraft({ ...draft, departmentId: event.target.value });
            }}
          >
            <option value="">{t('common.all')}</option>
            {(departments.data ?? []).map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="people-status">{t('people.employmentStatus')}</Label>
          <NativeSelect
            id="people-status"
            value={draft.employmentStatus}
            onChange={(event) => {
              setDraft({ ...draft, employmentStatus: event.target.value });
            }}
          >
            <option value="">{t('common.all')}</option>
            {EMPLOYMENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`people.statuses.${status}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="people-member-status">{t('people.memberStatus')}</Label>
          <NativeSelect
            id="people-member-status"
            value={draft.memberStatus}
            onChange={(event) => {
              setDraft({ ...draft, memberStatus: event.target.value });
            }}
          >
            <option value="">{t('common.all')}</option>
            {MEMBER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`people.memberStatuses.${status}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          {t('common.apply')}
        </Button>
      </form>

      {employees.isPending ? (
        <ListSkeleton />
      ) : employees.isError ? (
        <ErrorState
          error={employees.error}
          onRetry={() => {
            void employees.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState message={filtered ? t('people.emptyFiltered') : t('people.empty')} />
      ) : (
        <>
          <Card className="hidden md:block">
            <Table>
              <thead>
                <TableRow>
                  <TableHead>{t('people.name')}</TableHead>
                  <TableHead>{t('people.employeeNumber')}</TableHead>
                  <TableHead>{t('people.department')}</TableHead>
                  <TableHead>{t('people.jobTitle')}</TableHead>
                  <TableHead>{t('people.employmentStatus')}</TableHead>
                  <TableHead>{t('people.memberStatus')}</TableHead>
                </TableRow>
              </thead>
              <tbody>
                {rows.map((employee) => (
                  <TableRow key={employee.id}>
                    <TableCell className="font-medium">
                      <Link href={`/people/${employee.id}`} className="underline-offset-4 hover:underline">
                        {employee.fullName}
                      </Link>
                    </TableCell>
                    <TableCell>{employee.employeeNumber}</TableCell>
                    <TableCell>{employee.department?.name ?? t('common.none')}</TableCell>
                    <TableCell>{employee.jobTitle?.name ?? t('common.none')}</TableCell>
                    <TableCell>
                      <EmploymentStatusBadge status={employee.employmentStatus} />
                    </TableCell>
                    <TableCell>
                      <MemberStatusBadge status={employee.memberStatus} />
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </Card>
          <ul className="flex flex-col gap-3 md:hidden">
            {rows.map((employee) => (
              <li key={employee.id}>
                <Link
                  href={`/people/${employee.id}`}
                  className="flex flex-col gap-2 rounded-lg border p-4 hover:bg-accent"
                >
                  <span className="font-medium">{employee.fullName}</span>
                  <span className="text-sm text-muted-foreground">
                    {employee.employeeNumber}
                    {employee.department === null ? '' : ` · ${employee.department.name}`}
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <EmploymentStatusBadge status={employee.employmentStatus} />
                    <MemberStatusBadge status={employee.memberStatus} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {employees.hasNextPage ? (
            <Button
              variant="outline"
              className="self-center"
              disabled={employees.isFetchingNextPage}
              onClick={() => {
                void employees.fetchNextPage();
              }}
            >
              {employees.isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function CreateEmployeeButton() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setInvitation(null);
        }
      }}
    >
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        <PlusIcon aria-hidden="true" />
        {t('people.newEmployee')}
      </Button>
      <DialogContent title={t('people.newEmployee')} closeLabel={t('common.close')}>
        {invitation === null ? (
          <EmployeeForm
            onCreated={(result) => {
              setInvitation(result.invitation);
            }}
          />
        ) : (
          <>
            <p role="status">{t('people.created')}</p>
            <InvitationNotice invitation={invitation} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
