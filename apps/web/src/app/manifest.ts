import type { MetadataRoute } from 'next';

import { defaultLocale, getDirection, messages } from '@company-ops/i18n';

export default function manifest(): MetadataRoute.Manifest {
  const catalog = messages[defaultLocale];
  return {
    name: catalog.app.name,
    short_name: catalog.app.shortName,
    description: catalog.app.name,
    lang: defaultLocale,
    dir: getDirection(defaultLocale),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#171717',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
