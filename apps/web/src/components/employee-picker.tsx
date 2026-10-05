'use client';

import { useTranslations } from 'next-intl';
import { useDeferredValue, useId, useState } from 'react';

import { Input, Label } from '@company-ops/ui/components/input';

import { useEmployees } from '../lib/queries';

export interface PickedEmployee {
  readonly id: string;
  readonly fullName: string;
}

/**
 * Search-as-you-type employee chooser built from native radio inputs (keyboard and screen-reader
 * friendly without a custom combobox). Results come from the scoped employee list endpoint.
 */
export function EmployeePicker({
  label,
  value,
  onChange,
  allowNone = false,
  identity = 'employee',
}: {
  readonly label: string;
  readonly value: PickedEmployee | null;
  readonly onChange: (value: PickedEmployee | null) => void;
  readonly allowNone?: boolean;
  /** `member`: `id` is the organization member id (approvers, delegates, member form fields). */
  readonly identity?: 'employee' | 'member';
}) {
  const t = useTranslations();
  const id = useId();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim());
  const results = useEmployees(deferred === '' ? {} : { q: deferred });
  const options = (results.data?.pages[0]?.data ?? [])
    .slice(0, 8)
    .map((employee) => ({ ...employee, id: identity === 'member' ? employee.memberId : employee.id }));

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <Label htmlFor={`${id}-search`} className="sr-only">
        {t('people.search')}
      </Label>
      <Input
        id={`${id}-search`}
        type="search"
        placeholder={t('people.searchPlaceholder')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />
      <div className="flex max-h-56 flex-col overflow-y-auto rounded-md border">
        {allowNone ? (
          <label className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm hover:bg-accent">
            <input
              type="radio"
              name={id}
              checked={value === null}
              onChange={() => {
                onChange(null);
              }}
            />
            {t('common.none')}
          </label>
        ) : null}
        {value !== null && !options.some((option) => option.id === value.id) ? (
          <label className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm hover:bg-accent">
            <input type="radio" name={id} checked readOnly />
            {value.fullName}
          </label>
        ) : null}
        {options.map((option) => (
          <label
            key={option.id}
            className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm hover:bg-accent"
          >
            <input
              type="radio"
              name={id}
              checked={value?.id === option.id}
              onChange={() => {
                onChange({ id: option.id, fullName: option.fullName });
              }}
            />
            <span>
              {option.fullName} <span className="text-muted-foreground">· {option.employeeNumber}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
