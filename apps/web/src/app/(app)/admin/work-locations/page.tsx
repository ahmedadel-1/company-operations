'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, NativeSelect } from '@company-ops/ui/components/input';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import { Field, fieldErrorsOf, FormError } from '../../../../components/form';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, request } from '../../../../lib/api';
import { useWorkLocations } from '../../../../lib/projects';
import type { WorkLocation } from '../../../../lib/projects';
import { useCan, useCanOrgWide } from '../../../../lib/session';

const LOCATION_TYPES = ['OFFICE', 'CUSTOMER_SITE', 'PROJECT_SITE', 'OTHER'] as const;

export default function WorkLocationsPage() {
  const t = useTranslations();
  const can = useCan();
  const orgWide = useCanOrgWide();
  const [includeInactive, setIncludeInactive] = useState(false);
  const readable = can('attendance.config') || can('project.manage') || can('project.create');
  const manage = orgWide('attendance.config');
  const locations = useWorkLocations(includeInactive, readable);
  if (!readable) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader
        title={t('locations.title')}
        description={t('locations.description')}
        actions={manage ? <LocationDialog /> : undefined}
      />
      <label className="mb-4 flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeInactive}
          onChange={(event) => {
            setIncludeInactive(event.target.checked);
          }}
        />
        {t('locations.showInactive')}
      </label>
      {locations.isPending ? (
        <ListSkeleton />
      ) : locations.isError ? (
        <ErrorState
          error={locations.error}
          onRetry={() => {
            void locations.refetch();
          }}
        />
      ) : locations.data.length === 0 ? (
        <EmptyState message={t('locations.empty')} />
      ) : (
        <>
          <Card className="hidden md:block">
            <Table>
              <thead>
                <TableRow>
                  <TableHead>{t('locations.name')}</TableHead>
                  <TableHead>{t('locations.type')}</TableHead>
                  <TableHead>{t('locations.coordinates')}</TableHead>
                  <TableHead>{t('locations.radius')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TableHead>
                </TableRow>
              </thead>
              <tbody>
                {locations.data.map((location) => (
                  <TableRow key={location.id}>
                    <TableCell className="font-medium">
                      {location.name} {location.active ? null : <Badge>{t('locations.inactive')}</Badge>}
                    </TableCell>
                    <TableCell>{t(`locations.types.${location.type}`)}</TableCell>
                    <TableCell dir="ltr">
                      {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
                    </TableCell>
                    <TableCell>{t('locations.meters', { value: location.allowedRadiusMeters })}</TableCell>
                    <TableCell className="text-end">{manage ? <LocationDialog location={location} /> : null}</TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </Card>
          <ul className="flex flex-col gap-3 md:hidden">
            {locations.data.map((location) => (
              <li key={location.id} className="flex flex-col gap-2 rounded-lg border p-4">
                <span className="font-medium">
                  {location.name} {location.active ? null : <Badge>{t('locations.inactive')}</Badge>}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t(`locations.types.${location.type}`)} ·{' '}
                  {t('locations.meters', { value: location.allowedRadiusMeters })}
                </span>
                {manage ? <LocationDialog location={location} /> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function LocationDialog({ location }: { readonly location?: WorkLocation }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: location?.name ?? '',
    type: location?.type ?? 'OFFICE',
    latitude: location === undefined ? '' : String(location.latitude),
    longitude: location === undefined ? '' : String(location.longitude),
    allowedRadiusMeters: location === undefined ? '150' : String(location.allowedRadiusMeters),
    address: location?.address ?? '',
    timeZone: location?.timeZone ?? '',
    active: location?.active ?? true,
  });
  const save = useMutation({
    mutationFn: async () => {
      const type = LOCATION_TYPES.find((value) => value === draft.type) ?? 'OTHER';
      const body = {
        name: draft.name.trim(),
        type,
        latitude: Number(draft.latitude),
        longitude: Number(draft.longitude),
        allowedRadiusMeters: Number(draft.allowedRadiusMeters),
        address: draft.address.trim() === '' ? null : draft.address.trim(),
        timeZone: draft.timeZone.trim() === '' ? null : draft.timeZone.trim(),
        active: draft.active,
      };
      return location === undefined
        ? request(() => api.POST('/api/v1/work-locations', { body }))
        : request(() => api.PATCH('/api/v1/work-locations/{id}', { params: { path: { id: location.id } }, body }));
    },
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['work-locations'] });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };
  const title = location === undefined ? t('locations.new') : t('locations.edit');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant={location === undefined ? 'default' : 'outline'}
        size={location === undefined ? 'default' : 'sm'}
        onClick={() => {
          setOpen(true);
        }}
      >
        {location === undefined ? <PlusIcon aria-hidden="true" /> : null}
        {location === undefined ? title : t('common.edit')}
        {location === undefined ? null : <span className="sr-only">{location.name}</span>}
      </Button>
      <DialogContent title={title} closeLabel={t('common.close')}>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <FormError error={save.error} />
          <Field label={t('locations.name')} errorCode={errors.get('name')}>
            {(control) => (
              <Input
                {...control}
                required
                maxLength={120}
                value={draft.name}
                onChange={(event) => {
                  setDraft({ ...draft, name: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={t('locations.type')} errorCode={errors.get('type')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={draft.type}
                onChange={(event) => {
                  const type = LOCATION_TYPES.find((value) => value === event.target.value);
                  if (type !== undefined) {
                    setDraft({ ...draft, type });
                  }
                }}
              >
                {LOCATION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`locations.types.${type}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('locations.latitude')}
              hint={t('locations.latitudeHint')}
              errorCode={errors.get('latitude')}
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  dir="ltr"
                  value={draft.latitude}
                  onChange={(event) => {
                    setDraft({ ...draft, latitude: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field
              label={t('locations.longitude')}
              hint={t('locations.longitudeHint')}
              errorCode={errors.get('longitude')}
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  dir="ltr"
                  value={draft.longitude}
                  onChange={(event) => {
                    setDraft({ ...draft, longitude: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>
          <Field
            label={t('locations.radius')}
            hint={t('locations.radiusHint')}
            errorCode={errors.get('allowedRadiusMeters')}
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={10}
                max={5000}
                value={draft.allowedRadiusMeters}
                onChange={(event) => {
                  setDraft({ ...draft, allowedRadiusMeters: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={t('locations.address')} errorCode={errors.get('address')} optional>
            {(control) => (
              <Input
                {...control}
                maxLength={500}
                value={draft.address}
                onChange={(event) => {
                  setDraft({ ...draft, address: event.target.value });
                }}
              />
            )}
          </Field>
          <Field
            label={t('locations.timeZone')}
            hint={t('locations.timeZoneHint')}
            errorCode={errors.get('timeZone')}
            optional
          >
            {(control) => (
              <Input
                {...control}
                dir="ltr"
                value={draft.timeZone}
                onChange={(event) => {
                  setDraft({ ...draft, timeZone: event.target.value });
                }}
              />
            )}
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(event) => {
                setDraft({ ...draft, active: event.target.checked });
              }}
            />
            {t('locations.active')}
          </label>
          <Button type="submit" className="self-end" disabled={save.isPending || draft.name.trim() === ''}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
