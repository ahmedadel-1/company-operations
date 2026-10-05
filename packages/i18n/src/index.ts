import ar from '../messages/ar.json' with { type: 'json' };
import en from '../messages/en.json' with { type: 'json' };

export const locales = ['en', 'ar'] as const;

export type Locale = (typeof locales)[number];

export type Direction = 'ltr' | 'rtl';

export const defaultLocale: Locale = 'en';

/**
 * Locales offered to users. Both catalogs are complete (enforced by the catalog tests); the Arabic
 * text still needs a native-speaker review before an Arabic rollout (UI_UX.md §8).
 */
export const enabledLocales: readonly Locale[] = ['en', 'ar'];

const directions: Readonly<Record<Locale, Direction>> = {
  en: 'ltr',
  ar: 'rtl',
};

export type Messages = typeof en;

export const messages: Readonly<Record<Locale, Messages>> = { en, ar };

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function getDirection(locale: Locale): Direction {
  return directions[locale];
}
