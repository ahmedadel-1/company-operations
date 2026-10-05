/**
 * Outbound email port (ARCHITECTURE §3, P3-9). Only the worker sends email; the SMTP adapter lives
 * there. Development uses Mailpit. Messages carry ticket numbers, titles and links, never comment
 * bodies or internal notes.
 */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Stable per delivery (`<delivery-id@host>`), so a resent message can be recognized as a duplicate. */
  readonly messageId: string;
  readonly language: 'en' | 'ar';
}

export interface EmailChannel {
  /** False when no SMTP server is configured: deliveries are then recorded as SKIPPED. */
  readonly enabled: boolean;
  send(message: EmailMessage): Promise<void>;
}

export const DISABLED_EMAIL: EmailChannel = {
  enabled: false,
  send: () => Promise.reject(new Error('Email is not configured.')),
};
