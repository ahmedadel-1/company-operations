'use client';

import { SearchIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Label, NativeSelect } from '@company-ops/ui/components/input';
import { cn } from '@company-ops/ui/lib/utils';

import { SEARCH_MIN_LENGTH, SEARCH_TYPES, useSearch } from '../lib/dashboard';
import type { SearchType } from '../lib/dashboard';
import { linkHref, oneOf } from '../lib/link-params';
import { useErrorMessage } from './states';

const OPEN_EVENT = 'ops:open-search';
const DEBOUNCE_MS = 250;

/** Opens the global search from anywhere (quick actions, the mobile header). */
export function openSearch(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return debounced;
}

/** Header trigger: a search field look-alike on desktop (with the shortcut hint), an icon on phones. */
export function SearchTrigger() {
  const t = useTranslations('search');
  return (
    <>
      <Button
        variant="outline"
        className="hidden min-w-56 justify-start gap-2 text-muted-foreground md:inline-flex"
        onClick={openSearch}
        data-testid="search-trigger"
      >
        <SearchIcon aria-hidden="true" />
        <span className="flex-1 text-start">{t('placeholder')}</span>
        <kbd className="rounded border px-1.5 text-[10px]" dir="ltr">
          Ctrl K
        </kbd>
      </Button>
      <Button variant="ghost" size="icon" className="md:hidden" aria-label={t('open')} onClick={openSearch}>
        <SearchIcon aria-hidden="true" />
      </Button>
    </>
  );
}

/**
 * Global search (P8-6). Results come only from the authorized API; the palette never filters or ranks
 * on the client. Keyboard: Ctrl/Cmd+K opens, arrows move, Enter opens, Escape closes.
 */
export function SearchDialog() {
  const t = useTranslations('search');
  const common = useTranslations('common');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? (
        <DialogContent
          title={t('title')}
          closeLabel={common('close')}
          className="md:max-w-2xl"
          data-testid="search-dialog"
        >
          <SearchPanel
            onNavigate={() => {
              setOpen(false);
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function SearchPanel({ onNavigate }: { readonly onNavigate: () => void }) {
  const t = useTranslations('search');
  const common = useTranslations('common');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const router = useRouter();
  const message = useErrorMessage();
  const [text, setText] = useState('');
  const [type, setType] = useState<SearchType | ''>('');
  const [active, setActive] = useState(0);
  const query = useDebounced(text, DEBOUNCE_MS);
  const types = type === '' ? [] : [type];
  const search = useSearch(query, types, locale);
  const listId = useId();
  const typeId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const groups = (() => {
    const pages = search.data?.pages ?? [];
    if (type === '') return pages[0]?.groups ?? [];
    const items = pages.flatMap((page) => page.groups.flatMap((group) => group.items));
    return [{ type, items, nextCursor: pages.at(-1)?.groups[0]?.nextCursor ?? null }];
  })().filter((group) => group.items.length > 0);
  const flat = groups.flatMap((group) => group.items.map((item) => ({ group: group.type, item })));
  const offsets = groups.map((_, groupIndex) =>
    groups.slice(0, groupIndex).reduce((sum, group) => sum + group.items.length, 0),
  );
  const tooShort = query.normalize('NFKC').trim().length < SEARCH_MIN_LENGTH;
  const optionId = (index: number) => `${listId}-option-${String(index)}`;

  const go = (index: number) => {
    const target = flat[index];
    if (target === undefined) return;
    onNavigate();
    const url = new URL(linkHref(target.item.link), window.location.href);
    // A router push that changes only the fragment fires no `hashchange`, so the open screen's tabs
    // would not follow it; a native fragment navigation does.
    if (url.hash !== '' && url.pathname === window.location.pathname && url.search === window.location.search) {
      window.location.assign(url.href);
      return;
    }
    router.push(url.pathname + url.search + url.hash);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(flat.length === 0 ? 0 : (active + 1) % flat.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(flat.length === 0 ? 0 : (active - 1 + flat.length) % flat.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(active);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={`${listId}-input`} className="sr-only">
            {t('label')}
          </Label>
          <input
            ref={inputRef}
            id={`${listId}-input`}
            type="search"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length > 0 ? optionId(active) : undefined}
            autoComplete="off"
            maxLength={100}
            autoFocus
            placeholder={t('placeholder')}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="flex h-11 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            data-testid="search-input"
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:w-44">
          <Label htmlFor={typeId} className="sr-only">
            {t('type')}
          </Label>
          <NativeSelect
            id={typeId}
            value={type}
            onChange={(event) => {
              setType(oneOf(event.target.value, SEARCH_TYPES) ?? '');
              setActive(0);
              inputRef.current?.focus();
            }}
          >
            <option value="">{t('allTypes')}</option>
            {SEARCH_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`types.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div aria-live="polite" className="text-sm text-muted-foreground">
        {tooShort
          ? t('minLength', { count: SEARCH_MIN_LENGTH })
          : search.isError
            ? message(search.error)
            : search.isFetching && flat.length === 0
              ? common('loading')
              : flat.length === 0 && search.isSuccess
                ? t('noResults')
                : search.isSuccess
                  ? t('resultCount', { count: flat.length })
                  : null}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={t('results')}
        className="flex flex-col gap-3"
        data-testid="search-results"
      >
        {groups.map((group, groupIndex) => (
          <div
            key={group.type}
            role="group"
            aria-labelledby={`${listId}-${group.type}`}
            data-testid={`search-group-${group.type}`}
          >
            <p
              id={`${listId}-${group.type}`}
              className="px-2 pb-1 text-xs font-semibold text-muted-foreground uppercase"
            >
              {t(`types.${group.type}`)}
            </p>
            <div className="flex flex-col">
              {group.items.map((item, itemIndex) => {
                const current = (offsets[groupIndex] ?? 0) + itemIndex;
                return (
                  <div
                    key={`${group.type}-${item.id}`}
                    id={optionId(current)}
                    role="option"
                    aria-selected={current === active}
                    className={cn(
                      'flex min-h-11 cursor-pointer flex-col justify-center rounded-md px-2 py-1.5',
                      current === active && 'bg-accent',
                    )}
                    onMouseMove={() => {
                      setActive(current);
                    }}
                    onClick={() => {
                      go(current);
                    }}
                    data-testid="search-result"
                  >
                    <span className="text-sm font-medium">
                      {item.key === null ? null : <span className="text-muted-foreground">{item.key} </span>}
                      {item.title}
                    </span>
                    {item.subtitle === null ? null : (
                      <span className="text-xs text-muted-foreground">{item.subtitle}</span>
                    )}
                  </div>
                );
              })}
            </div>
            {type === '' && group.nextCursor !== null ? (
              <button
                type="button"
                className="min-h-11 px-2 text-sm underline underline-offset-4"
                onClick={() => {
                  setType(group.type);
                  setActive(0);
                }}
              >
                {t('moreOfType', { type: t(`types.${group.type}`) })}
              </button>
            ) : null}
          </div>
        ))}
        {type !== '' && search.hasNextPage ? (
          <Button
            variant="outline"
            className="self-center"
            disabled={search.isFetchingNextPage}
            onClick={() => {
              void search.fetchNextPage();
            }}
          >
            {search.isFetchingNextPage ? common('loading') : common('loadMore')}
          </Button>
        ) : null}
      </div>
      <p className="hidden text-xs text-muted-foreground md:block">{t('keyboardHint')}</p>
    </div>
  );
}
