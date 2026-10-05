'use client';

import { useFormatter } from 'next-intl';

import { useOrganization } from './queries';

/** Dates and times in the user's locale and the organization's configured time zone (UI_UX.md §8). */
export function useDateFormat() {
  const format = useFormatter();
  const organization = useOrganization();
  const timeZone = organization.data?.timeZone;
  return {
    dateTime: (value: string) =>
      format.dateTime(new Date(value), {
        dateStyle: 'medium',
        timeStyle: 'short',
        ...(timeZone === undefined ? {} : { timeZone }),
      }),
    date: (value: string) =>
      // Calendar dates (YYYY-MM-DD) have no time zone; format them as UTC so the day never shifts.
      format.dateTime(new Date(`${value}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }),
  };
}
