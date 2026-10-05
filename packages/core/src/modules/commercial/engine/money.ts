import { Prisma } from '@company-ops/db';

/**
 * Money (ADR-0026): numeric(19,4) in PostgreSQL, `Prisma.Decimal` in memory, a decimal string on the
 * wire. Never a JavaScript number; amounts in different currencies are never added or converted.
 */
export interface Money {
  readonly amount: string;
  readonly currency: string;
}

export const ZERO = new Prisma.Decimal(0);

export function decimal(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

/** Canonical wire form: fixed four fractional digits trimmed of trailing zeros ("1200.5", "0"). */
export function formatAmount(value: Prisma.Decimal): string {
  const fixed = value.toFixed(4);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

export function toMoney(amount: Prisma.Decimal | null, currency: string | null): Money | undefined {
  if (amount === null || currency === null) return undefined;
  return { amount: formatAmount(amount), currency };
}

export function sumDecimals(values: readonly Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((total, value) => total.plus(value), ZERO);
}

/** Totals per currency, sorted by currency code (dashboard and reports never mix currencies). */
export function totalsByCurrency(rows: readonly { amount: Prisma.Decimal; currency: string }[]): Money[] {
  const totals = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? ZERO).plus(row.amount));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount: formatAmount(amount) }));
}
