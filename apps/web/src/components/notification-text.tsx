'use client';

import { useLocale, useTranslations } from 'next-intl';

const KNOWN_TYPES = [
  'ROLE_GRANTED',
  'ROLE_REVOKED',
  'INVITATION_ACCEPTED',
  'PROJECT_MEMBER_ADDED',
  'PROJECT_MANAGER_ASSIGNED',
  'PROJECT_TECHNICAL_MANAGER_ASSIGNED',
  'DAILY_REPORT_MISSING',
  'DAILY_REPORTS_MISSING_SUMMARY',
  'SUPPORT_TICKET_CREATED',
  'SUPPORT_TICKET_ASSIGNED',
  'SUPPORT_TICKET_TEAM_ASSIGNED',
  'SUPPORT_TICKET_ESCALATED',
  'SUPPORT_TICKET_INTERNAL_NOTE',
  'SUPPORT_TICKET_REPORTER_REPLIED',
  'SUPPORT_TICKET_REPLIED',
  'SUPPORT_TICKET_COMMENTED',
  'SUPPORT_TICKET_RESOLVED',
  'SUPPORT_TICKET_VERIFIED',
  'SUPPORT_TICKET_STATUS_CHANGED',
  'SUPPORT_SLA_AT_RISK',
  'SUPPORT_SLA_BREACHED',
  'JIRA_REAUTH_REQUIRED',
  'JIRA_ISSUE_STATUS_CHANGED',
  'JIRA_ISSUE_CREATED',
  'GITHUB_INSTALLATION_SUSPENDED',
  'GITHUB_INSTALLATION_DELETED',
  'REQUEST_APPROVAL_ASSIGNED',
  'REQUEST_APPROVAL_UNASSIGNED',
  'REQUEST_APPROVAL_OVERDUE',
  'REQUEST_APPROVED',
  'REQUEST_REJECTED',
  'REQUEST_CANCELLED',
  'REQUEST_COMPLETED',
  'REQUEST_FULFILLMENT_REQUIRED',
  'REQUEST_DELEGATION_RECEIVED',
  'REQUEST_DELEGATION_REVOKED',
  'ATTENDANCE_MISSING_CHECKOUT',
  'ATTENDANCE_REVIEW_DECIDED',
] as const;
type KnownType = (typeof KNOWN_TYPES)[number];

const COMMERCIAL_TYPES = [
  'TENDER_SUBMITTED',
  'TENDER_AWARDED',
  'TENDER_LOST',
  'TENDER_DEADLINE_APPROACHING',
  'TENDER_LOW_READINESS',
  'TENDER_REQUIREMENT_ASSIGNED',
  'TENDER_REQUIREMENT_DUE_SOON',
  'TENDER_REQUIREMENT_OVERDUE',
  'TENDER_REQUIREMENT_REVIEW_REQUESTED',
  'TENDER_REQUIREMENT_CHANGES_REQUIRED',
  'TENDER_REVIEW_REQUESTED',
  'TENDER_FINAL_APPROVAL_REQUESTED',
  'TENDER_REVIEW_REJECTED',
  'TENDER_REVIEW_CHANGES_REQUIRED',
  'TENDER_READY_FOR_SUBMISSION',
  'CORPORATE_DOCUMENT_EXPIRING',
  'CORPORATE_DOCUMENT_EXPIRED',
  'CONTRACT_STATUS_CHANGED',
  'CONTRACT_EXPIRY_APPROACHING',
  'CONTRACT_EXPIRED',
  'CONTRACT_RENEWAL_DECISION_DUE',
  'CONTRACT_NOTICE_DEADLINE_APPROACHING',
  'CONTRACT_OBLIGATION_ASSIGNED',
  'CONTRACT_OBLIGATION_DUE_SOON',
  'CONTRACT_OBLIGATION_OVERDUE',
  'CONTRACT_MILESTONE_ASSIGNED',
  'CONTRACT_MILESTONE_DUE_SOON',
  'CONTRACT_MILESTONE_OVERDUE',
  'CONTRACT_MILESTONE_SUBMITTED',
  'CONTRACT_AMENDMENT_APPROVAL_REQUESTED',
  'CONTRACT_AMENDMENT_APPROVED',
  'CONTRACT_AMENDMENT_REJECTED',
  'GUARANTEE_EXPIRING',
  'GUARANTEE_EXPIRED',
] as const;
type CommercialType = (typeof COMMERCIAL_TYPES)[number];

function isCommercial(type: string): type is CommercialType {
  return (COMMERCIAL_TYPES as readonly string[]).includes(type);
}

const PROJECT_ROLES = [
  'PROJECT_MANAGER',
  'TECHNICAL_MANAGER',
  'DEVELOPER',
  'SUPPORT',
  'FIELD',
  'QA',
  'OBSERVER',
] as const;

const TICKET_STATUSES = [
  'NEW',
  'TRIAGED',
  'IN_PROGRESS',
  'ESCALATED',
  'WAITING_FOR_DEVELOPMENT',
  'WAITING_FOR_CUSTOMER',
  'RESOLVED',
  'VERIFIED',
  'CLOSED',
  'CANCELLED',
] as const;

function isKnown(type: string): type is KnownType {
  return (KNOWN_TYPES as readonly string[]).includes(type);
}

/** Where a notification leads: the entity page when the UI has one, else the notification list. */
export function notificationHref(item: {
  readonly entityType: string | null;
  readonly entityId: string | null;
}): string {
  if (item.entityType === 'support_ticket' && item.entityId !== null) {
    return `/support/tickets/${item.entityId}`;
  }
  if (item.entityType === 'request' && item.entityId !== null) {
    return `/requests/${item.entityId}`;
  }
  if (item.entityType === 'approval_delegation') {
    return '/approvals/delegations';
  }
  if (item.entityType === 'attendance_record' && item.entityId !== null) {
    return `/attendance/records/${item.entityId}`;
  }
  if (item.entityType === 'jira_connection') {
    return '/admin/integrations/jira';
  }
  if (item.entityType === 'github_installation') {
    return '/admin/integrations/github';
  }
  if (item.entityType === 'tender' && item.entityId !== null) {
    return `/tenders/${item.entityId}`;
  }
  if (item.entityType === 'contract' && item.entityId !== null) {
    return `/contracts/${item.entityId}`;
  }
  if (item.entityType === 'corporate_document') {
    return item.entityId === null ? '/documents' : `/documents?open=${item.entityId}`;
  }
  return '/notifications';
}

/** Localized text for a notification from its stable `type` and `params` (never server-rendered prose). */
export function useNotificationText(): (type: string, params: Record<string, unknown>) => string {
  const t = useTranslations('notifications.types');
  const roles = useTranslations('projects.roles');
  const statuses = useTranslations('support.statuses');
  const sla = useTranslations('support.slaInfo');
  const commercial = useTranslations('commercial');
  const locale = useLocale();
  return (type, params) => {
    if (isCommercial(type)) {
      const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
      const label = (group: string, value: unknown) => {
        const key = `${group}.${text(value)}`;
        return commercial.has(key as 'none') ? commercial(key as 'none') : text(value);
      };
      const deadline = typeof params.deadline === 'string' ? params.deadline.slice(0, 10) : '';
      return t(type, {
        tender: text(params.tenderKey),
        contract: text(params.contractKey),
        title: text(params.tenderTitle) || text(params.contractTitle),
        item:
          text(params.requirementTitle) ||
          text(params.obligationTitle) ||
          text(params.milestoneTitle) ||
          text(params.itemTitle),
        amendment: text(params.amendmentKey),
        parent: text(params.parentKey),
        document: text(params.documentTitle),
        documentType: label('documentTypes', params.documentType),
        guaranteeType: label('guaranteeTypes', params.guaranteeType),
        gate: label('reviewGates', params.gate),
        status: label('contractStatuses', params.status),
        date: text(params.dueDate) || text(params.expiryDate) || text(params.date) || deadline,
        days: typeof params.days === 'number' ? params.days : 0,
        approved: typeof params.approved === 'number' ? params.approved : 0,
        applicable: typeof params.applicable === 'number' ? params.applicable : 0,
      });
    }
    if (!isKnown(type)) {
      return t('generic');
    }
    const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
    const roleName = text(params.roleName);
    const project = text(params.projectName);
    const ticket = { ticket: text(params.ticketNumber), title: text(params.title) };
    const typeName =
      locale === 'ar' && typeof params.typeNameAr === 'string' ? params.typeNameAr : text(params.typeName);
    const requestParams = { request: text(params.requestNumber), typeName };
    switch (type) {
      case 'ROLE_GRANTED':
        return t('ROLE_GRANTED', { roleName });
      case 'ROLE_REVOKED':
        return t('ROLE_REVOKED', { roleName });
      case 'INVITATION_ACCEPTED':
        return t('INVITATION_ACCEPTED');
      case 'PROJECT_MEMBER_ADDED': {
        const role = PROJECT_ROLES.find((value) => value === params.projectRole);
        return t('PROJECT_MEMBER_ADDED', { project, role: role === undefined ? '' : roles(role) });
      }
      case 'PROJECT_MANAGER_ASSIGNED':
        return t('PROJECT_MANAGER_ASSIGNED', { project });
      case 'PROJECT_TECHNICAL_MANAGER_ASSIGNED':
        return t('PROJECT_TECHNICAL_MANAGER_ASSIGNED', { project });
      case 'DAILY_REPORT_MISSING':
        return t('DAILY_REPORT_MISSING', { project, date: text(params.date) });
      case 'DAILY_REPORTS_MISSING_SUMMARY':
        return t('DAILY_REPORTS_MISSING_SUMMARY', {
          project,
          date: text(params.date),
          count: typeof params.count === 'number' ? params.count : 0,
        });
      case 'SUPPORT_TICKET_ESCALATED':
        return t('SUPPORT_TICKET_ESCALATED', { ...ticket, level: text(params.level) });
      case 'SUPPORT_TICKET_STATUS_CHANGED': {
        const status = TICKET_STATUSES.find((value) => value === params.status);
        return t('SUPPORT_TICKET_STATUS_CHANGED', { ...ticket, status: status === undefined ? '' : statuses(status) });
      }
      case 'SUPPORT_SLA_AT_RISK':
      case 'SUPPORT_SLA_BREACHED':
        return t(type, {
          ...ticket,
          clock: params.clock === 'FIRST_RESPONSE' ? sla('firstResponse') : sla('resolution'),
        });
      case 'SUPPORT_TICKET_CREATED':
      case 'SUPPORT_TICKET_ASSIGNED':
      case 'SUPPORT_TICKET_TEAM_ASSIGNED':
      case 'SUPPORT_TICKET_INTERNAL_NOTE':
      case 'SUPPORT_TICKET_REPORTER_REPLIED':
      case 'SUPPORT_TICKET_REPLIED':
      case 'SUPPORT_TICKET_COMMENTED':
      case 'SUPPORT_TICKET_RESOLVED':
      case 'SUPPORT_TICKET_VERIFIED':
        return t(type, ticket);
      case 'JIRA_REAUTH_REQUIRED':
        return t('JIRA_REAUTH_REQUIRED', { site: text(params.site) });
      case 'JIRA_ISSUE_STATUS_CHANGED':
        return t('JIRA_ISSUE_STATUS_CHANGED', { ...ticket, issue: text(params.issueKey), status: text(params.status) });
      case 'JIRA_ISSUE_CREATED':
        return t('JIRA_ISSUE_CREATED', { ...ticket, issue: text(params.issueKey) });
      case 'GITHUB_INSTALLATION_SUSPENDED':
      case 'GITHUB_INSTALLATION_DELETED':
        return t(type, { account: text(params.account) });
      case 'REQUEST_APPROVAL_ASSIGNED':
      case 'REQUEST_APPROVAL_UNASSIGNED':
      case 'REQUEST_APPROVAL_OVERDUE':
      case 'REQUEST_APPROVED':
      case 'REQUEST_REJECTED':
      case 'REQUEST_CANCELLED':
      case 'REQUEST_COMPLETED':
      case 'REQUEST_FULFILLMENT_REQUIRED':
        return t(type, requestParams);
      case 'REQUEST_DELEGATION_RECEIVED':
      case 'REQUEST_DELEGATION_REVOKED':
        return t(type, { delegator: text(params.delegatorName), delegate: text(params.delegateName) });
      case 'ATTENDANCE_MISSING_CHECKOUT':
        return t('ATTENDANCE_MISSING_CHECKOUT', { date: text(params.date) });
      case 'ATTENDANCE_REVIEW_DECIDED':
        return t(params.decision === 'REJECTED' ? 'ATTENDANCE_REVIEW_REJECTED' : 'ATTENDANCE_REVIEW_ACCEPTED', {
          date: text(params.date),
        });
    }
  };
}
