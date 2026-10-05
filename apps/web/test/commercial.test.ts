import { describe, expect, it } from 'vitest';

import { notificationHref } from '../src/components/notification-text';
import { amountOrUndefined, zonedInputToIso } from '../src/lib/commercial';

describe('zonedInputToIso()', () => {
  it('reads the input as wall time in the given zone, not the browser zone', () => {
    expect(zonedInputToIso('2026-10-20T12:00', 'Africa/Cairo')).toBe('2026-10-20T09:00:00.000Z');
    expect(zonedInputToIso('2026-01-15T12:00', 'Africa/Cairo')).toBe('2026-01-15T10:00:00.000Z');
    expect(zonedInputToIso('2026-10-20T12:00', 'Asia/Riyadh')).toBe('2026-10-20T09:00:00.000Z');
    expect(zonedInputToIso('2026-10-20T12:00', 'UTC')).toBe('2026-10-20T12:00:00.000Z');
  });

  it('rejects empty and malformed values', () => {
    expect(zonedInputToIso('', 'UTC')).toBeUndefined();
    expect(zonedInputToIso('2026-10-20', 'UTC')).toBeUndefined();
  });
});

describe('amountOrUndefined()', () => {
  it('accepts only canonical decimal amounts', () => {
    expect(amountOrUndefined(' 125000.50 ')).toBe('125000.50');
    expect(amountOrUndefined('1,000')).toBeUndefined();
    expect(amountOrUndefined('-5')).toBeUndefined();
    expect(amountOrUndefined('1.23456')).toBeUndefined();
  });
});

describe('notificationHref()', () => {
  const id = '0b5f7c1e-2a4d-4c8e-9f10-123456789abc';

  it('opens commercial records, a corporate document inside the vault', () => {
    expect(notificationHref({ entityType: 'tender', entityId: id })).toBe(`/tenders/${id}`);
    expect(notificationHref({ entityType: 'contract', entityId: id })).toBe(`/contracts/${id}`);
    expect(notificationHref({ entityType: 'corporate_document', entityId: id })).toBe(`/documents?open=${id}`);
    expect(notificationHref({ entityType: 'corporate_document', entityId: null })).toBe('/documents');
  });
});
