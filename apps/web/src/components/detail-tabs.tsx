'use client';

import { useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { useLocationHash } from '../lib/link-params';

/**
 * Accessible tab bar whose selection is mirrored in the URL fragment, so dashboard and notification
 * links (`/tenders/<id>#requirements`) open the right tab. Arrow keys follow the reading direction.
 */
export function DetailTabs<T extends string>({
  tabs,
  label,
  labelOf,
  render,
}: {
  readonly tabs: readonly T[];
  readonly label: string;
  readonly labelOf: (tab: T) => string;
  readonly render: (tab: T) => ReactNode;
}) {
  // Rendered only after the record loaded on the client, so the initial hash can be read here.
  const [tab, setTab] = useState<T>(() => {
    const fromHash = typeof window === 'undefined' ? '' : window.location.hash.replace('#', '');
    return tabs.find((candidate) => candidate === fromHash) ?? tabs[0] ?? ('' as T);
  });
  // A later fragment change on the same screen (a search result for another tab) selects that tab.
  const hash = useLocationHash();
  const [seenHash, setSeenHash] = useState(hash);
  if (hash !== seenHash) {
    setSeenHash(hash);
    const fromHash = tabs.find((candidate) => candidate === hash);
    if (fromHash !== undefined) setTab(fromHash);
  }
  const buttonsRef = useRef(new Map<T, HTMLButtonElement>());
  const current = tabs.includes(tab) ? tab : (tabs[0] ?? tab);

  const select = (next: T) => {
    setTab(next);
    window.history.replaceState(null, '', `#${next}`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.indexOf(current);
    const rtl = document.documentElement.dir === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: T | undefined;
    if (event.key === forward) {
      next = tabs[(index + 1) % tabs.length];
    } else if (event.key === backward) {
      next = tabs[(index - 1 + tabs.length) % tabs.length];
    } else if (event.key === 'Home') {
      next = tabs[0];
    } else if (event.key === 'End') {
      next = tabs.at(-1);
    }
    if (next !== undefined) {
      event.preventDefault();
      select(next);
      buttonsRef.current.get(next)?.focus();
    }
  };

  return (
    <>
      <div className="relative mb-6 overflow-x-auto border-b">
        <div role="tablist" aria-label={label} className="flex min-w-max gap-1" onKeyDown={onKeyDown}>
          {tabs.map((key) => (
            <button
              key={key}
              ref={(node) => {
                if (node === null) {
                  buttonsRef.current.delete(key);
                } else {
                  buttonsRef.current.set(key, node);
                }
              }}
              type="button"
              role="tab"
              id={`tab-${key}`}
              aria-selected={current === key}
              aria-controls={current === key ? `panel-${key}` : undefined}
              tabIndex={current === key ? 0 : -1}
              onClick={() => {
                select(key);
              }}
              className="min-h-11 border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground aria-selected:border-primary aria-selected:text-foreground"
            >
              {labelOf(key)}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={`panel-${current}`} aria-labelledby={`tab-${current}`} tabIndex={0}>
        {render(current)}
      </div>
    </>
  );
}
