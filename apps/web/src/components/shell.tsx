'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellIcon, CheckCheckIcon, LifeBuoyIcon, LogOutIcon, MenuIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';

import { enabledLocales, isLocale } from '@company-ops/i18n';
import type { Locale } from '@company-ops/i18n';
import { LOCALE_COOKIE } from '@company-ops/shared';
import type { PermissionKey } from '@company-ops/shared';
import { Button } from '@company-ops/ui/components/button';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@company-ops/ui/components/dropdown-menu';
import { Skeleton } from '@company-ops/ui/components/skeleton';
import { cn } from '@company-ops/ui/lib/utils';

import { api, request, setCsrfToken } from '../lib/api';
import { currentPath, loginUrl, onAuthProblem, stepUpUrl } from '../lib/auth-events';
import { useLiveUpdates } from '../lib/live-updates';
import { queryKeys, useMe, useNotifications, useOrganization, useOwnProfile, useUnreadCount } from '../lib/queries';
import { useApprovalSummary } from '../lib/requests';
import { MeProvider, useCan, useSession } from '../lib/session';
import type { Me } from '../lib/session';
import { isActive, isPermitted, NAV_GROUPS } from './nav-items';
import type { NavItem } from './nav-items';
import { notificationHref, useNotificationText } from './notification-text';
import { SearchDialog, SearchTrigger } from './search-dialog';
import { ErrorState } from './states';

export function AppShell({ children }: { readonly children: ReactNode }) {
  const me = useMe();
  const [sessionExpired, setSessionExpired] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);

  useEffect(
    () =>
      onAuthProblem((problem) => {
        if (problem === 'session-expired') {
          setSessionExpired(true);
        } else {
          setMfaRequired(true);
        }
      }),
    [],
  );

  if (sessionExpired) {
    return <SessionExpiredScreen />;
  }
  if (me.isPending) {
    return <SessionLoading />;
  }
  if (me.isError) {
    return (
      <main id="main" className="mx-auto max-w-xl p-6">
        <ErrorState
          error={me.error}
          onRetry={() => {
            void me.refetch();
          }}
        />
      </main>
    );
  }
  return (
    <MeProvider me={me.data}>
      <LocaleSync />
      <LiveUpdates />
      <AuthenticatedLayout>{children}</AuthenticatedLayout>
      <MfaDialog open={mfaRequired} onOpenChange={setMfaRequired} />
    </MeProvider>
  );
}

function SessionLoading() {
  const t = useTranslations('auth');
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6" aria-busy="true">
      <p role="status" className="text-muted-foreground">
        {t('loadingSession')}
      </p>
      <Skeleton className="h-2 w-48" />
    </main>
  );
}

function SessionExpiredScreen() {
  const t = useTranslations('auth');
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h1 className="text-2xl font-semibold">{t('sessionExpiredTitle')}</h1>
      <p className="text-muted-foreground">{t('sessionExpiredBody')}</p>
      <Button asChild>
        <a href={loginUrl(currentPath())}>{t('signInAgain')}</a>
      </Button>
    </main>
  );
}

function MfaDialog({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const t = useTranslations();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('auth.mfaTitle')} description={t('auth.mfaBody')} closeLabel={t('common.close')}>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button asChild>
            <a href={stepUpUrl(currentPath())}>{t('auth.mfaContinue')}</a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function readLocaleCookie(): string | null {
  const match = document.cookie.split('; ').find((part) => part.startsWith(`${LOCALE_COOKIE}=`));
  return match === undefined ? null : match.slice(LOCALE_COOKIE.length + 1);
}

export function writeLocaleCookie(locale: Locale): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

/** Applies the saved language (member preference, else organization default) to the server-rendered `<html lang dir>`. */
function LocaleSync() {
  const locale = useLocale();
  const router = useRouter();
  const profile = useOwnProfile();
  const organization = useOrganization();

  useEffect(() => {
    if (!profile.isSuccess || !organization.isSuccess) {
      return;
    }
    const saved = profile.data?.locale ?? null;
    const cookie = readLocaleCookie();
    const wanted = saved ?? (cookie !== null && isLocale(cookie) ? cookie : organization.data.defaultLocale);
    if (isLocale(wanted) && enabledLocales.includes(wanted) && wanted !== locale) {
      writeLocaleCookie(wanted);
      router.refresh();
    }
  }, [profile.isSuccess, profile.data, organization.isSuccess, organization.data, locale, router]);

  return null;
}

function LiveUpdates() {
  useLiveUpdates();
  return null;
}

function useVisibleGroups() {
  const can = useCan();
  const me = useSession();
  const beyondSelf = (permission: PermissionKey) =>
    me.permissions.some((grant) => grant.key === permission && grant.scopes.some((scope) => scope !== 'SELF'));
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => isPermitted(item, can, beyondSelf)),
  })).filter((group) => group.items.length > 0);
}

function AuthenticatedLayout({ children }: { readonly children: ReactNode }) {
  const t = useTranslations('nav');
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-4 py-2 focus:not-sr-only focus:fixed focus:start-2 focus:top-2"
      >
        {t('skipToContent')}
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 pb-24 md:px-6 md:pb-6">
          {children}
        </main>
      </div>
      <BottomNav />
      <SearchDialog />
    </div>
  );
}

function NavLink({
  item,
  compact,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly compact: boolean;
  readonly onNavigate?: () => void;
}) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const active = isActive(pathname, item.href, item.exact);
  const pending = useApprovalSummary(item.label === 'approvals').data ?? 0;
  const pendingId = useId();
  const Icon = item.icon;
  return (
    <>
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        title={compact ? t(item.label) : undefined}
        aria-describedby={pending > 0 ? pendingId : undefined}
        {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
        className={cn(
          'relative flex min-h-11 items-center gap-3 rounded-md px-3 text-sm hover:bg-accent',
          active && 'bg-accent font-medium',
          compact && 'justify-center px-0 lg:justify-start lg:px-3',
        )}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className={cn(compact && 'sr-only lg:not-sr-only')}>{t(item.label)}</span>
        {pending > 0 ? (
          <span
            aria-hidden="true"
            className={cn(
              'rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums',
              compact ? 'absolute end-1 top-1 lg:static lg:ms-auto' : 'ms-auto',
            )}
          >
            {pending > 99 ? '99+' : pending}
          </span>
        ) : null}
      </Link>
      {pending > 0 ? (
        <span id={pendingId} className="sr-only">
          {t('approvalsPending', { count: pending })}
        </span>
      ) : null}
    </>
  );
}

/** Icon rail on tablets (768–1023 px), full sidebar on desktop (UI_UX.md §1). */
function Sidebar() {
  const t = useTranslations();
  const groups = useVisibleGroups();
  return (
    <nav
      aria-label={t('nav.mainNavigation')}
      className="sticky top-0 hidden h-dvh w-16 shrink-0 flex-col gap-4 overflow-y-auto border-e p-2 md:flex lg:w-60 lg:p-3"
    >
      <Link href="/" className="flex min-h-11 items-center justify-center px-1 font-semibold lg:justify-start lg:px-3">
        <span className="hidden lg:inline">{t('app.shortName')}</span>
        <span aria-hidden="true" className="lg:hidden">
          OH
        </span>
        <span className="sr-only lg:hidden">{t('app.shortName')}</span>
      </Link>
      {groups.map((group) => (
        <div key={group.label ?? 'main'} className="flex flex-col gap-1">
          {group.label === null ? null : (
            <p className="hidden px-3 text-xs font-medium text-muted-foreground uppercase lg:block">
              {t(`nav.${group.label}`)}
            </p>
          )}
          {group.items.map((item) => (
            <NavLink key={item.href} item={item} compact />
          ))}
        </div>
      ))}
    </nav>
  );
}

/**
 * Bottom bar below 768 px (UI_UX.md §2): Home, Employees, the emphasized center "Report issue"
 * action (ticket create), Notifications, More. The support inbox is in the More sheet.
 */
function BottomNav() {
  const t = useTranslations();
  const can = useCan();
  const pathname = usePathname();
  const groups = useVisibleGroups();
  const [moreOpen, setMoreOpen] = useState(false);
  // Phase 7: Attendance takes slot 2 for members who record attendance (UI_UX.md §2); Employees moves to More.
  const order = can('attendance.self') ? ['/', '/attendance', '/notifications'] : ['/', '/people', '/notifications'];
  const primary = NAV_GROUPS.flatMap((group) => group.items).filter(
    (item) => order.includes(item.href) && isPermitted(item, can),
  );
  primary.sort((a, b) => order.indexOf(a.href) - order.indexOf(b.href));
  const slots: (NavItem | 'report')[] = [...primary];
  if (can('support.create')) {
    slots.splice(Math.min(2, slots.length), 0, 'report');
  }

  return (
    <nav
      aria-label={t('nav.mobileNavigation')}
      className="fixed inset-x-0 bottom-0 z-30 grid auto-cols-fr grid-flow-col border-t bg-background md:hidden"
    >
      {slots.map((item) => {
        if (item === 'report') {
          const active = pathname === '/support/new';
          return (
            <Link
              key="report"
              href="/support/new"
              aria-current={active ? 'page' : undefined}
              className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-semibold"
            >
              <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <LifeBuoyIcon aria-hidden="true" className="size-5" />
              </span>
              {t('nav.reportIssue')}
            </Link>
          );
        }
        const Icon = item.icon;
        const active = isActive(pathname, item.href, item.exact);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs',
              active && 'font-semibold',
            )}
          >
            <Icon aria-hidden="true" className="size-5" />
            {t(`nav.${item.label}`)}
          </Link>
        );
      })}
      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <button
          type="button"
          className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs"
          aria-haspopup="dialog"
          onClick={() => {
            setMoreOpen(true);
          }}
        >
          <MenuIcon aria-hidden="true" className="size-5" />
          {t('nav.more')}
        </button>
        <DialogContent variant="sheet" title={t('nav.more')} closeLabel={t('common.close')}>
          <nav aria-label={t('nav.more')} className="flex flex-col gap-4">
            {groups.map((group) => (
              <div key={group.label ?? 'main'} className="flex flex-col gap-1">
                {group.label === null ? null : (
                  <p className="px-3 text-xs font-medium text-muted-foreground uppercase">{t(`nav.${group.label}`)}</p>
                )}
                {group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    compact={false}
                    onNavigate={() => {
                      setMoreOpen(false);
                    }}
                  />
                ))}
              </div>
            ))}
          </nav>
        </DialogContent>
      </Dialog>
    </nav>
  );
}

function TopBar() {
  const me = useSession();
  return (
    <header className="sticky top-0 z-20 flex min-h-14 items-center justify-between gap-3 border-b bg-background/95 px-4 backdrop-blur md:px-6">
      <p className="truncate font-medium" data-testid="active-organization">
        {me.activeOrganization.name}
      </p>
      <div className="flex items-center gap-1">
        <SearchTrigger />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}

function NotificationBell() {
  const t = useTranslations('notifications');
  const unread = useUnreadCount();
  const latest = useNotifications(false, 10);
  const text = useNotificationText();
  const queryClient = useQueryClient();
  const markAll = useMutation({
    mutationFn: () => request(() => api.POST('/api/v1/notifications/read-all')),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const count = unread.data ?? 0;
  const items = latest.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={count > 0 ? t('bellUnread', { count }) : t('bell')}
          className="relative"
        >
          <BellIcon aria-hidden="true" />
          {count > 0 ? (
            <span
              aria-hidden="true"
              className="absolute end-1.5 top-1.5 min-w-4 rounded-full bg-destructive px-1 text-[10px] leading-4 text-destructive-foreground"
            >
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80">
        <DropdownMenuLabel>{t('title')}</DropdownMenuLabel>
        {items.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          items.map((item) => (
            <DropdownMenuItem key={item.id} asChild>
              <Link href={notificationHref(item)} className={cn(item.readAt === null && 'font-medium')}>
                {item.readAt === null ? <span className="sr-only">{t('unread')}: </span> : null}
                <span className="line-clamp-2">{text(item.type, item.params)}</span>
              </Link>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        {count > 0 ? (
          <DropdownMenuItem
            onSelect={() => {
              markAll.mutate();
            }}
          >
            <CheckCheckIcon aria-hidden="true" />
            {t('markAllRead')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem asChild>
          <Link href="/notifications">{t('viewAll')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function UserMenu() {
  const t = useTranslations();
  const me = useSession();
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const profile = useOwnProfile();

  const switchOrganization = useMutation({
    mutationFn: (organizationId: string) =>
      request(() => api.PUT('/api/v1/me/active-organization', { body: { organizationId } })),
    onSuccess: async (result) => {
      setCsrfToken(result.data.csrfToken);
      router.push('/');
      await queryClient.resetQueries();
    },
  });

  const changeLocale = useMutation({
    mutationFn: async (next: Locale) => {
      if (profile.data !== null && profile.data !== undefined) {
        await request(() => api.PATCH('/api/v1/me/profile', { body: { locale: next } }));
      }
      return next;
    },
    onSuccess: async (next) => {
      writeLocaleCookie(next);
      await queryClient.invalidateQueries({ queryKey: queryKeys.ownProfile });
      router.refresh();
    },
  });

  const signOut = useMutation({
    mutationFn: () => request(() => api.POST('/api/v1/auth/logout')),
    onSuccess: (result) => {
      window.location.assign(result.data.logoutUrl);
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('nav.userMenu')} data-testid="user-menu">
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-semibold"
          >
            {initials(me.user.displayName)}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel className="flex flex-col">
          <span className="text-sm font-medium text-foreground">{me.user.displayName}</span>
          {me.user.email === null ? null : <span>{me.user.email}</span>}
        </DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href="/profile">
            <UserIcon aria-hidden="true" />
            {t('nav.profile')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('nav.language')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            if (isLocale(value) && value !== locale) {
              changeLocale.mutate(value);
            }
          }}
        >
          {enabledLocales.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} lang={option}>
              {t(`locales.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {me.memberships.length > 1 ? (
          <OrganizationSwitcher
            me={me}
            onSwitch={(id) => {
              switchOrganization.mutate(id);
            }}
          />
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signOut.isPending}
          onSelect={(event) => {
            event.preventDefault();
            signOut.mutate();
          }}
        >
          <LogOutIcon aria-hidden="true" />
          {signOut.isPending ? t('nav.signingOut') : t('nav.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Shown only for members of more than one organization (UI_UX.md §1). */
function OrganizationSwitcher({
  me,
  onSwitch,
}: {
  readonly me: Me;
  readonly onSwitch: (organizationId: string) => void;
}) {
  const t = useTranslations('nav');
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('organizations')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={me.activeOrganization.id}
        onValueChange={(value) => {
          if (value !== me.activeOrganization.id) {
            onSwitch(value);
          }
        }}
      >
        {me.memberships.map((membership) => (
          <DropdownMenuRadioItem key={membership.organizationId} value={membership.organizationId}>
            {membership.name}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
