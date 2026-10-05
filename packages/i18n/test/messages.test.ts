import { describe, expect, it } from 'vitest';

import { defaultLocale, enabledLocales, getDirection, isLocale, locales, messages } from '../src/index.js';

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

function leafValues(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null) {
    return [value];
  }
  return Object.values(value).flatMap(leafValues);
}

describe('message catalogs', () => {
  it('every locale has exactly the keys of the default locale', () => {
    const expected = keyPaths(messages[defaultLocale]).sort();
    for (const locale of locales) {
      expect(keyPaths(messages[locale]).sort(), locale).toEqual(expected);
    }
  });

  it('has only non-empty string translations', () => {
    for (const locale of locales) {
      for (const value of leafValues(messages[locale])) {
        expect(typeof value === 'string' && value.trim().length > 0, `${locale}: ${String(value)}`).toBe(true);
      }
    }
  });
});

describe('locale helpers', () => {
  it('uses English as the initial and default locale', () => {
    expect(defaultLocale).toBe('en');
    expect(enabledLocales).toContain('en');
  });

  it('marks Arabic as right-to-left', () => {
    expect(getDirection('ar')).toBe('rtl');
    expect(getDirection('en')).toBe('ltr');
  });

  it('recognises supported locales only', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });
});
