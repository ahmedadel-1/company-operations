import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { DISABLED_EMAIL } from '@company-ops/core';
import type { EmailChannel, EmailMessage } from '@company-ops/core';

import type { WorkerEnv } from '../config/worker-env.js';

/** Upper bounds so a hung SMTP server fails the attempt (and BullMQ retries) instead of stalling the worker. */
const SMTP_TIMEOUT_MS = 15_000;

/** SMTP adapter of the email port (P3-9). Mailpit in development; any relay in production. */
export class SmtpEmailChannel implements EmailChannel {
  readonly enabled = true;

  constructor(
    private readonly transporter: Transporter,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      messageId: message.messageId,
      headers: { 'Content-Language': message.language, 'Auto-Submitted': 'auto-generated' },
    });
  }

  close(): void {
    this.transporter.close();
  }
}

export function createEmailChannel(env: WorkerEnv): EmailChannel {
  if (env.SMTP_HOST === undefined || env.SMTP_FROM === undefined) {
    return DISABLED_EMAIL;
  }
  const transporter = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    // Production relays must offer STARTTLS; development (Mailpit) may be plain.
    requireTLS: env.NODE_ENV === 'production' && !env.SMTP_SECURE,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    ...(env.SMTP_USER !== undefined && env.SMTP_PASSWORD !== undefined
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
      : {}),
  });
  return new SmtpEmailChannel(transporter, env.SMTP_FROM);
}

/** Message-ID domain: the public host, so ids are globally unique per deployment. */
export function messageIdHost(env: WorkerEnv): string {
  return new URL(env.APP_PUBLIC_URL).hostname;
}
