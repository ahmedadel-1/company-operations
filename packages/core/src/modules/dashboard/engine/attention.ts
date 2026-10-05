/** Needs Attention model (ADR-0023): deterministic, rule-based, deduplicated by source entity. */
export type AttentionSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type AttentionType =
  | 'TICKET_SLA_BREACHED'
  | 'TICKET_CRITICAL_UNASSIGNED'
  | 'TICKET_SLA_AT_RISK'
  | 'PROJECT_CRITICAL'
  | 'PROJECT_AT_RISK'
  | 'APPROVAL_OVERDUE'
  | 'APPROVAL_WAITING'
  | 'ATTENDANCE_MISSING_CHECKOUT'
  | 'ATTENDANCE_REVIEWS_WAITING'
  | 'DAILY_REPORT_DUE'
  | 'REQUESTS_AWAITING_FULFILLMENT'
  | 'JIRA_CONNECTION_PROBLEM'
  | 'GITHUB_CONNECTION_PROBLEM'
  | 'TENDER_DEADLINE_AT_RISK'
  | 'TENDER_FINAL_APPROVAL'
  | 'TENDER_REVIEW_WAITING'
  | 'TENDER_REQUIREMENT_OVERDUE'
  | 'CONTRACT_NOTICE_DEADLINE'
  | 'CONTRACT_RENEWAL_DECISION'
  | 'CONTRACT_EXPIRING'
  | 'OBLIGATION_OVERDUE'
  | 'MILESTONE_OVERDUE'
  | 'GUARANTEE_EXPIRING'
  | 'GUARANTEE_EXPIRED'
  | 'AMENDMENT_APPROVAL_WAITING'
  | 'CORPORATE_DOCUMENT_EXPIRING';

export type AttentionScope = 'SELF' | 'TEAM' | 'DEPARTMENT' | 'PROJECT' | 'ORG';

export interface AttentionLink {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly hash: string | null;
}

export interface AttentionItem {
  readonly key: string;
  readonly type: AttentionType;
  readonly severity: AttentionSeverity;
  readonly params: Readonly<Record<string, string | number>>;
  readonly entity: { readonly type: string; readonly id: string };
  /** ISO-8601 instant the condition started. */
  readonly occurredAt: string;
  readonly link: AttentionLink;
  readonly scope: AttentionScope;
}

export const SEVERITY_RANK: Readonly<Record<AttentionSeverity, number>> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export const ATTENTION_CAP = 50;

/** Severity first, then the oldest condition (waiting longest), then the stable key. */
export function compareAttention(a: AttentionItem, b: AttentionItem): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** One item per source entity: the one that sorts first (highest severity) wins. */
export function dedupeAttention(items: readonly AttentionItem[]): AttentionItem[] {
  const best = new Map<string, AttentionItem>();
  for (const item of items) {
    const entityKey = `${item.entity.type}:${item.entity.id}`;
    const current = best.get(entityKey);
    if (current === undefined || compareAttention(item, current) < 0) {
      best.set(entityKey, item);
    }
  }
  return [...best.values()];
}

export interface PrioritizedAttention {
  readonly items: readonly AttentionItem[];
  readonly total: number;
  readonly truncated: boolean;
}

/** Deduplicates, orders deterministically and caps the feed. */
export function prioritizeAttention(
  items: readonly AttentionItem[],
  cap: number = ATTENTION_CAP,
): PrioritizedAttention {
  const unique = dedupeAttention(items).sort(compareAttention);
  return { items: unique.slice(0, cap), total: unique.length, truncated: unique.length > cap };
}
