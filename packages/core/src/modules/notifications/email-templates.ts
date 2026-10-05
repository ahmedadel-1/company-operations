/**
 * Localized email templates (P3-9). Rendered from the notification's type and i18n params only, so
 * an email can never contain more than the in-app notification (no comment bodies, no internal
 * notes). Every interpolated value is HTML-escaped and stripped of line breaks in the subject.
 */

export type EmailLanguage = 'en' | 'ar';

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

type Params = Readonly<Record<string, unknown>>;

interface Template {
  readonly subject: (p: Params) => string;
  readonly body: (p: Params) => string;
}

const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';

const clock = (p: Params, language: EmailLanguage): string => {
  const isFirstResponse = str(p.clock) === 'FIRST_RESPONSE';
  if (language === 'ar') {
    return isFirstResponse ? 'الاستجابة الأولى' : 'الحل';
  }
  return isFirstResponse ? 'first response' : 'resolution';
};

const typeNameAr = (p: Params): string => str(p.typeNameAr) || str(p.typeName);

const TEMPLATES: Readonly<Record<EmailLanguage, Readonly<Record<string, Template>>>> = {
  en: {
    SUPPORT_TICKET_ASSIGNED: {
      subject: (p) => `[${str(p.ticketNumber)}] Assigned to you: ${str(p.title)}`,
      body: (p) => `Support ticket ${str(p.ticketNumber)} "${str(p.title)}" has been assigned to you.`,
    },
    SUPPORT_TICKET_ESCALATED: {
      subject: (p) => `[${str(p.ticketNumber)}] Escalated to level ${str(p.level)}: ${str(p.title)}`,
      body: (p) => `Support ticket ${str(p.ticketNumber)} "${str(p.title)}" was escalated to level ${str(p.level)}.`,
    },
    SUPPORT_SLA_AT_RISK: {
      subject: (p) => `[${str(p.ticketNumber)}] SLA at risk: ${str(p.title)}`,
      body: (p) =>
        `The ${clock(p, 'en')} target of support ticket ${str(p.ticketNumber)} "${str(p.title)}" is at risk.`,
    },
    SUPPORT_SLA_BREACHED: {
      subject: (p) => `[${str(p.ticketNumber)}] SLA breached: ${str(p.title)}`,
      body: (p) =>
        `The ${clock(p, 'en')} target of support ticket ${str(p.ticketNumber)} "${str(p.title)}" was missed.`,
    },
    SUPPORT_TICKET_RESOLVED: {
      subject: (p) => `[${str(p.ticketNumber)}] Resolved: ${str(p.title)}`,
      body: (p) =>
        `Your support ticket ${str(p.ticketNumber)} "${str(p.title)}" was resolved. Please check the fix and verify it, or reopen the ticket.`,
    },
    SUPPORT_TICKET_VERIFIED: {
      subject: (p) => `[${str(p.ticketNumber)}] Resolution verified: ${str(p.title)}`,
      body: (p) => `The resolution of support ticket ${str(p.ticketNumber)} "${str(p.title)}" was verified.`,
    },
    SUPPORT_TICKET_REPLIED: {
      subject: (p) => `[${str(p.ticketNumber)}] New reply: ${str(p.title)}`,
      body: (p) => `Support replied on your ticket ${str(p.ticketNumber)} "${str(p.title)}".`,
    },
    SUPPORT_TICKET_REPORTER_REPLIED: {
      subject: (p) => `[${str(p.ticketNumber)}] Reporter replied: ${str(p.title)}`,
      body: (p) => `The reporter replied on support ticket ${str(p.ticketNumber)} "${str(p.title)}".`,
    },
    JIRA_REAUTH_REQUIRED: {
      subject: (p) => `Jira connection needs re-authorization: ${str(p.site)}`,
      body: (p) =>
        `Jira stopped accepting the stored authorization for "${str(p.site)}". Synchronization is paused until an administrator reconnects Jira.`,
    },
    GITHUB_INSTALLATION_SUSPENDED: {
      subject: (p) => `GitHub App installation suspended: ${str(p.account)}`,
      body: (p) =>
        `The GitHub App installation on "${str(p.account)}" was suspended on GitHub. Pull request synchronization is paused until it is unsuspended.`,
    },
    GITHUB_INSTALLATION_DELETED: {
      subject: (p) => `GitHub App uninstalled: ${str(p.account)}`,
      body: (p) =>
        `The GitHub App was uninstalled from "${str(p.account)}". Its repositories no longer synchronize; cached history is kept.`,
    },
    REQUEST_APPROVAL_ASSIGNED: {
      subject: (p) => `[${str(p.requestNumber)}] Approval needed: ${str(p.typeName)}`,
      body: (p) => `Request ${str(p.requestNumber)} (${str(p.typeName)}) is waiting for your approval.`,
    },
    REQUEST_APPROVAL_UNASSIGNED: {
      subject: (p) => `[${str(p.requestNumber)}] No approver found: ${str(p.typeName)}`,
      body: (p) =>
        `No approver could be resolved for a step of request ${str(p.requestNumber)} (${str(p.typeName)}). Please assign an approver.`,
    },
    REQUEST_APPROVAL_OVERDUE: {
      subject: (p) => `[${str(p.requestNumber)}] Approval overdue: ${str(p.typeName)}`,
      body: (p) => `Your approval of request ${str(p.requestNumber)} (${str(p.typeName)}) is overdue.`,
    },
    REQUEST_APPROVED: {
      subject: (p) => `[${str(p.requestNumber)}] Approved: ${str(p.typeName)}`,
      body: (p) => `Your request ${str(p.requestNumber)} (${str(p.typeName)}) was approved.`,
    },
    REQUEST_REJECTED: {
      subject: (p) => `[${str(p.requestNumber)}] Rejected: ${str(p.typeName)}`,
      body: (p) => `Your request ${str(p.requestNumber)} (${str(p.typeName)}) was rejected. Open it to see the reason.`,
    },
    REQUEST_COMPLETED: {
      subject: (p) => `[${str(p.requestNumber)}] Completed: ${str(p.typeName)}`,
      body: (p) => `Your request ${str(p.requestNumber)} (${str(p.typeName)}) was fulfilled.`,
    },
    TENDER_REVIEW_REQUESTED: {
      subject: (p) => `[${str(p.tenderKey)}] Review requested: ${str(p.tenderTitle)}`,
      body: (p) =>
        `Your ${str(p.gate).toLowerCase()} review of tender ${str(p.tenderKey)} "${str(p.tenderTitle)}" is requested.`,
    },
    TENDER_FINAL_APPROVAL_REQUESTED: {
      subject: (p) => `[${str(p.tenderKey)}] Final approval required: ${str(p.tenderTitle)}`,
      body: (p) =>
        `Tender ${str(p.tenderKey)} "${str(p.tenderTitle)}" is waiting for your final approval before submission.`,
    },
    TENDER_DEADLINE_APPROACHING: {
      subject: (p) => `[${str(p.tenderKey)}] Submission deadline in ${str(p.days)} day(s): ${str(p.tenderTitle)}`,
      body: (p) =>
        `The submission deadline of tender ${str(p.tenderKey)} "${str(p.tenderTitle)}" is in ${str(p.days)} day(s).`,
    },
    TENDER_LOW_READINESS: {
      subject: (p) => `[${str(p.tenderKey)}] Not ready near the deadline: ${str(p.tenderTitle)}`,
      body: (p) =>
        `Tender ${str(p.tenderKey)} "${str(p.tenderTitle)}" has ${str(p.approved)} of ${str(p.applicable)} mandatory requirements approved and its deadline is close.`,
    },
    CORPORATE_DOCUMENT_EXPIRING: {
      subject: (p) => `Document expires in ${str(p.days)} day(s): ${str(p.documentTitle)}`,
      body: (p) =>
        `The corporate document "${str(p.documentTitle)}" expires on ${str(p.expiryDate)}. Upload the renewed version in time.`,
    },
    CORPORATE_DOCUMENT_EXPIRED: {
      subject: (p) => `Document expired: ${str(p.documentTitle)}`,
      body: (p) => `The corporate document "${str(p.documentTitle)}" expired on ${str(p.expiryDate)}.`,
    },
    CONTRACT_EXPIRY_APPROACHING: {
      subject: (p) => `[${str(p.contractKey)}] Expires in ${str(p.days)} day(s): ${str(p.contractTitle)}`,
      body: (p) => `Contract ${str(p.contractKey)} "${str(p.contractTitle)}" expires on ${str(p.date)}.`,
    },
    CONTRACT_RENEWAL_DECISION_DUE: {
      subject: (p) => `[${str(p.contractKey)}] Renewal decision due: ${str(p.contractTitle)}`,
      body: (p) =>
        `The renewal decision for contract ${str(p.contractKey)} "${str(p.contractTitle)}" is due on ${str(p.date)}.`,
    },
    CONTRACT_NOTICE_DEADLINE_APPROACHING: {
      subject: (p) => `[${str(p.contractKey)}] Notice deadline in ${str(p.days)} day(s): ${str(p.contractTitle)}`,
      body: (p) =>
        `The renewal notice deadline of contract ${str(p.contractKey)} "${str(p.contractTitle)}" is ${str(p.date)}.`,
    },
    CONTRACT_EXPIRED: {
      subject: (p) => `[${str(p.contractKey)}] Expired: ${str(p.contractTitle)}`,
      body: (p) =>
        `Contract ${str(p.contractKey)} "${str(p.contractTitle)}" expired on ${str(p.expiryDate)} without a recorded renewal.`,
    },
    CONTRACT_OBLIGATION_OVERDUE: {
      subject: (p) => `[${str(p.contractKey)}] Obligation overdue: ${str(p.obligationTitle)}`,
      body: (p) =>
        `The obligation "${str(p.obligationTitle)}" of contract ${str(p.contractKey)} was due on ${str(p.dueDate)} and is not completed.`,
    },
    CONTRACT_AMENDMENT_APPROVAL_REQUESTED: {
      subject: (p) => `[${str(p.amendmentKey)}] Amendment approval required: ${str(p.contractTitle)}`,
      body: (p) =>
        `Amendment ${str(p.amendmentKey)} of contract ${str(p.contractKey)} "${str(p.contractTitle)}" is waiting for approval.`,
    },
    GUARANTEE_EXPIRED: {
      subject: (p) => `[${str(p.parentKey)}] Guarantee expired`,
      body: (p) =>
        `A guarantee of ${str(p.parentKey)} expired on ${str(p.expiryDate)} and was not released or extended.`,
    },
  },
  ar: {
    SUPPORT_TICKET_ASSIGNED: {
      subject: (p) => `[${str(p.ticketNumber)}] أُسندت إليك: ${str(p.title)}`,
      body: (p) => `أُسندت إليك تذكرة الدعم ${str(p.ticketNumber)} "${str(p.title)}".`,
    },
    SUPPORT_TICKET_ESCALATED: {
      subject: (p) => `[${str(p.ticketNumber)}] تصعيد إلى المستوى ${str(p.level)}: ${str(p.title)}`,
      body: (p) => `صُعّدت تذكرة الدعم ${str(p.ticketNumber)} "${str(p.title)}" إلى المستوى ${str(p.level)}.`,
    },
    SUPPORT_SLA_AT_RISK: {
      subject: (p) => `[${str(p.ticketNumber)}] اتفاقية مستوى الخدمة معرّضة للخطر: ${str(p.title)}`,
      body: (p) => `هدف ${clock(p, 'ar')} لتذكرة الدعم ${str(p.ticketNumber)} "${str(p.title)}" معرّض للخطر.`,
    },
    SUPPORT_SLA_BREACHED: {
      subject: (p) => `[${str(p.ticketNumber)}] تجاوز اتفاقية مستوى الخدمة: ${str(p.title)}`,
      body: (p) => `فات هدف ${clock(p, 'ar')} لتذكرة الدعم ${str(p.ticketNumber)} "${str(p.title)}".`,
    },
    SUPPORT_TICKET_RESOLVED: {
      subject: (p) => `[${str(p.ticketNumber)}] تم الحل: ${str(p.title)}`,
      body: (p) =>
        `تم حل تذكرة الدعم ${str(p.ticketNumber)} "${str(p.title)}". يرجى مراجعة الحل والتحقق منه أو إعادة فتح التذكرة.`,
    },
    SUPPORT_TICKET_VERIFIED: {
      subject: (p) => `[${str(p.ticketNumber)}] تم التحقق من الحل: ${str(p.title)}`,
      body: (p) => `تم التحقق من حل تذكرة الدعم ${str(p.ticketNumber)} "${str(p.title)}".`,
    },
    SUPPORT_TICKET_REPLIED: {
      subject: (p) => `[${str(p.ticketNumber)}] رد جديد: ${str(p.title)}`,
      body: (p) => `ردّ فريق الدعم على تذكرتك ${str(p.ticketNumber)} "${str(p.title)}".`,
    },
    SUPPORT_TICKET_REPORTER_REPLIED: {
      subject: (p) => `[${str(p.ticketNumber)}] ردّ مُبلّغ التذكرة: ${str(p.title)}`,
      body: (p) => `ردّ مُبلّغ تذكرة الدعم ${str(p.ticketNumber)} "${str(p.title)}".`,
    },
    JIRA_REAUTH_REQUIRED: {
      subject: (p) => `اتصال Jira يحتاج إلى إعادة التفويض: ${str(p.site)}`,
      body: (p) =>
        `توقف Jira عن قبول التفويض المحفوظ للموقع "${str(p.site)}". تتوقف المزامنة حتى يعيد أحد المسؤولين ربط Jira.`,
    },
    GITHUB_INSTALLATION_SUSPENDED: {
      subject: (p) => `تم تعليق تثبيت تطبيق GitHub: ${str(p.account)}`,
      body: (p) =>
        `عُلّق تثبيت تطبيق GitHub على "${str(p.account)}" في GitHub. تتوقف مزامنة طلبات الدمج حتى يُلغى التعليق.`,
    },
    GITHUB_INSTALLATION_DELETED: {
      subject: (p) => `أُزيل تطبيق GitHub: ${str(p.account)}`,
      body: (p) => `أُزيل تطبيق GitHub من "${str(p.account)}". لم تعد مستودعاته تُزامَن، ويُحتفظ بالسجل المخزّن.`,
    },
    REQUEST_APPROVAL_ASSIGNED: {
      subject: (p) => `[${str(p.requestNumber)}] موافقة مطلوبة: ${typeNameAr(p)}`,
      body: (p) => `الطلب ${str(p.requestNumber)} (${typeNameAr(p)}) بانتظار موافقتك.`,
    },
    REQUEST_APPROVAL_UNASSIGNED: {
      subject: (p) => `[${str(p.requestNumber)}] لم يُعثر على معتمد: ${typeNameAr(p)}`,
      body: (p) => `تعذّر تحديد معتمد لإحدى خطوات الطلب ${str(p.requestNumber)} (${typeNameAr(p)}). يرجى تعيين معتمد.`,
    },
    REQUEST_APPROVAL_OVERDUE: {
      subject: (p) => `[${str(p.requestNumber)}] موافقة متأخرة: ${typeNameAr(p)}`,
      body: (p) => `تأخرت موافقتك على الطلب ${str(p.requestNumber)} (${typeNameAr(p)}).`,
    },
    REQUEST_APPROVED: {
      subject: (p) => `[${str(p.requestNumber)}] تمت الموافقة: ${typeNameAr(p)}`,
      body: (p) => `تمت الموافقة على طلبك ${str(p.requestNumber)} (${typeNameAr(p)}).`,
    },
    REQUEST_REJECTED: {
      subject: (p) => `[${str(p.requestNumber)}] مرفوض: ${typeNameAr(p)}`,
      body: (p) => `رُفض طلبك ${str(p.requestNumber)} (${typeNameAr(p)}). افتحه لمعرفة السبب.`,
    },
    REQUEST_COMPLETED: {
      subject: (p) => `[${str(p.requestNumber)}] مكتمل: ${typeNameAr(p)}`,
      body: (p) => `تم تنفيذ طلبك ${str(p.requestNumber)} (${typeNameAr(p)}).`,
    },
    TENDER_REVIEW_REQUESTED: {
      subject: (p) => `[${str(p.tenderKey)}] مراجعة مطلوبة: ${str(p.tenderTitle)}`,
      body: (p) => `مطلوب منك مراجعة المناقصة ${str(p.tenderKey)} "${str(p.tenderTitle)}".`,
    },
    TENDER_FINAL_APPROVAL_REQUESTED: {
      subject: (p) => `[${str(p.tenderKey)}] الاعتماد النهائي مطلوب: ${str(p.tenderTitle)}`,
      body: (p) => `المناقصة ${str(p.tenderKey)} "${str(p.tenderTitle)}" بانتظار اعتمادك النهائي قبل التقديم.`,
    },
    TENDER_DEADLINE_APPROACHING: {
      subject: (p) => `[${str(p.tenderKey)}] موعد التقديم بعد ${str(p.days)} يوم: ${str(p.tenderTitle)}`,
      body: (p) => `موعد تقديم المناقصة ${str(p.tenderKey)} "${str(p.tenderTitle)}" بعد ${str(p.days)} يوم.`,
    },
    TENDER_LOW_READINESS: {
      subject: (p) => `[${str(p.tenderKey)}] غير جاهزة مع اقتراب الموعد: ${str(p.tenderTitle)}`,
      body: (p) =>
        `اعتُمد ${str(p.approved)} من ${str(p.applicable)} متطلبات إلزامية للمناقصة ${str(p.tenderKey)} "${str(p.tenderTitle)}" وموعدها قريب.`,
    },
    CORPORATE_DOCUMENT_EXPIRING: {
      subject: (p) => `مستند ينتهي بعد ${str(p.days)} يوم: ${str(p.documentTitle)}`,
      body: (p) =>
        `ينتهي مستند الشركة "${str(p.documentTitle)}" في ${str(p.expiryDate)}. يرجى رفع النسخة المجددة في الوقت المناسب.`,
    },
    CORPORATE_DOCUMENT_EXPIRED: {
      subject: (p) => `مستند منتهي: ${str(p.documentTitle)}`,
      body: (p) => `انتهت صلاحية مستند الشركة "${str(p.documentTitle)}" في ${str(p.expiryDate)}.`,
    },
    CONTRACT_EXPIRY_APPROACHING: {
      subject: (p) => `[${str(p.contractKey)}] ينتهي بعد ${str(p.days)} يوم: ${str(p.contractTitle)}`,
      body: (p) => `ينتهي العقد ${str(p.contractKey)} "${str(p.contractTitle)}" في ${str(p.date)}.`,
    },
    CONTRACT_RENEWAL_DECISION_DUE: {
      subject: (p) => `[${str(p.contractKey)}] قرار التجديد مستحق: ${str(p.contractTitle)}`,
      body: (p) => `قرار تجديد العقد ${str(p.contractKey)} "${str(p.contractTitle)}" مستحق في ${str(p.date)}.`,
    },
    CONTRACT_NOTICE_DEADLINE_APPROACHING: {
      subject: (p) => `[${str(p.contractKey)}] موعد الإشعار بعد ${str(p.days)} يوم: ${str(p.contractTitle)}`,
      body: (p) => `آخر موعد لإشعار تجديد العقد ${str(p.contractKey)} "${str(p.contractTitle)}" هو ${str(p.date)}.`,
    },
    CONTRACT_EXPIRED: {
      subject: (p) => `[${str(p.contractKey)}] منتهٍ: ${str(p.contractTitle)}`,
      body: (p) =>
        `انتهى العقد ${str(p.contractKey)} "${str(p.contractTitle)}" في ${str(p.expiryDate)} دون تسجيل تجديد.`,
    },
    CONTRACT_OBLIGATION_OVERDUE: {
      subject: (p) => `[${str(p.contractKey)}] التزام متأخر: ${str(p.obligationTitle)}`,
      body: (p) =>
        `الالتزام "${str(p.obligationTitle)}" في العقد ${str(p.contractKey)} كان مستحقًا في ${str(p.dueDate)} ولم يكتمل.`,
    },
    CONTRACT_AMENDMENT_APPROVAL_REQUESTED: {
      subject: (p) => `[${str(p.amendmentKey)}] اعتماد تعديل مطلوب: ${str(p.contractTitle)}`,
      body: (p) =>
        `التعديل ${str(p.amendmentKey)} على العقد ${str(p.contractKey)} "${str(p.contractTitle)}" بانتظار الاعتماد.`,
    },
    GUARANTEE_EXPIRED: {
      subject: (p) => `[${str(p.parentKey)}] انتهاء ضمان`,
      body: (p) => `انتهى ضمان مرتبط بـ ${str(p.parentKey)} في ${str(p.expiryDate)} دون إفراج أو تمديد.`,
    },
  },
};

/** Notification types that are also delivered by email (the producer still opts in per request). */
export const EMAIL_NOTIFICATION_TYPES: ReadonlySet<string> = new Set(Object.keys(TEMPLATES.en));

const FALLBACK: Readonly<Record<EmailLanguage, Template>> = {
  en: { subject: () => 'New notification', body: () => 'You have a new notification in Company Operations.' },
  ar: { subject: () => 'إشعار جديد', body: () => 'لديك إشعار جديد في نظام عمليات الشركة.' },
};

const UI: Readonly<
  Record<
    EmailLanguage,
    { open: string; footer: string; adminFooter: string; requestFooter: string; commercialFooter: string }
  >
> = {
  en: {
    open: 'Open in Company Operations',
    footer: 'You receive this email because of your role in this support ticket.',
    adminFooter: 'You receive this email because you manage integrations for your organization.',
    requestFooter: 'You receive this email because of your role in this request.',
    commercialFooter: 'You receive this email because of your role in this tender, contract or document.',
  },
  ar: {
    open: 'فتح في نظام عمليات الشركة',
    footer: 'تصلك هذه الرسالة بسبب دورك في تذكرة الدعم هذه.',
    adminFooter: 'تصلك هذه الرسالة لأنك تدير عمليات التكامل في مؤسستك.',
    requestFooter: 'تصلك هذه الرسالة بسبب دورك في هذا الطلب.',
    commercialFooter: 'تصلك هذه الرسالة بسبب دورك في هذه المناقصة أو العقد أو المستند.',
  },
};

const COMMERCIAL_PREFIXES = ['TENDER_', 'CONTRACT_', 'CORPORATE_DOCUMENT_', 'GUARANTEE_'] as const;

function footerFor(type: string, labels: (typeof UI)[EmailLanguage]): string {
  if (type.startsWith('JIRA_') || type.startsWith('GITHUB_')) return labels.adminFooter;
  if (type.startsWith('REQUEST_')) return labels.requestFooter;
  if (COMMERCIAL_PREFIXES.some((prefix) => type.startsWith(prefix))) return labels.commercialFooter;
  return labels.footer;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const singleLine = (value: string): string =>
  value
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 250);

export function renderNotificationEmail(input: {
  readonly type: string;
  readonly params: Params;
  readonly language: EmailLanguage;
  readonly link: string;
}): RenderedEmail {
  const template = TEMPLATES[input.language][input.type] ?? FALLBACK[input.language];
  const subject = singleLine(template.subject(input.params));
  const body = template.body(input.params);
  const labels = UI[input.language];
  const ui = {
    open: labels.open,
    footer: footerFor(input.type, labels),
  };
  const dir = input.language === 'ar' ? 'rtl' : 'ltr';
  const text = `${body}\n\n${ui.open}: ${input.link}\n\n${ui.footer}\n`;
  const html =
    `<!doctype html><html lang="${input.language}" dir="${dir}"><body>` +
    `<p>${escapeHtml(body)}</p>` +
    `<p><a href="${escapeHtml(input.link)}">${escapeHtml(ui.open)}</a></p>` +
    `<p style="color:#666;font-size:12px">${escapeHtml(ui.footer)}</p>` +
    `</body></html>`;
  return { subject, text, html };
}
