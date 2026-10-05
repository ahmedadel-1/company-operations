import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { defaultLocale, enabledLocales, isLocale, messages } from '@company-ops/i18n';
import { LOCALE_COOKIE } from '@company-ops/shared';

/**
 * The locale comes from the `ops_locale` cookie, which the app keeps in sync with the member's saved
 * preference (falling back to the organization default) once `/api/v1/me/profile` has loaded.
 */
export default getRequestConfig(async () => {
  const requested = (await cookies()).get(LOCALE_COOKIE)?.value ?? '';
  const locale = isLocale(requested) && enabledLocales.includes(requested) ? requested : defaultLocale;
  return { locale, messages: messages[locale] };
});
