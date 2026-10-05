import type { Locale, Messages } from '@company-ops/i18n';

declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
