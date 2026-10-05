import { Controller, Inject, Req, Sse, UseGuards } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';

import { canAccessResource, permissionChannel, userChannel } from '@company-ops/core';

import { AuthService } from '../auth/auth.service.js';
import { unauthenticated } from '../http/errors/http-errors.js';
import type { HttpRequest } from '../http/http-types.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';
import { RealtimeHub } from './realtime-hub.js';
import { StreamCapacityGuard } from './stream-capacity.guard.js';

export const HEARTBEAT_MS = 25_000;
export const SESSION_RECHECK_MS = 60_000;

/**
 * `GET /notifications/events/stream` (Server-Sent Events, ADR-0011). Pushes "something changed"
 * hints for the caller: their own notifications and tickets they report, are assigned or watch, and
 * (for ORG-wide support viewers) organization-wide support queue changes, and Jira sync progress for
 * integration administrators, requests they take part in and (for ORG-wide fulfillers) the fulfillment
 * queue. Events carry a type and
 * an entity id only; the client re-fetches through the authorized API. The stream re-checks its
 * session every minute without refreshing it (idle sessions still expire) and closes when the
 * session ends or the member's grants change. At most five streams per user per API process.
 */
@ApiTags('notifications')
@Controller({ path: 'notifications/events', version: '1' })
export class RealtimeController {
  constructor(
    @Inject(RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Sse('stream')
  @UseGuards(StreamCapacityGuard)
  @ApiResponse({
    status: 200,
    description: 'text/event-stream of `change` events `{ type, entityType, entityId }` and `ping` heartbeats',
  })
  @ApiResponse({ status: 429, description: 'The user already has the maximum number of open streams' })
  async stream(@Req() request: HttpRequest): Promise<Observable<MessageEvent>> {
    const state = request.auth;
    if (state === undefined) {
      throw unauthenticated();
    }
    const { principal } = await this.actions.create(request);
    const { organizationId, userId } = principal;
    const channels = [userChannel(organizationId, userId)];
    if (canAccessResource(principal, 'support.view', { organizationId })) {
      channels.push(permissionChannel(organizationId, 'support.view'));
    }
    if (canAccessResource(principal, 'integration.manage', { organizationId })) {
      channels.push(permissionChannel(organizationId, 'integration.manage'));
    }
    if (canAccessResource(principal, 'request.fulfill', { organizationId })) {
      channels.push(permissionChannel(organizationId, 'request.fulfill'));
    }
    const { sessionId, session } = state;
    // The slot is taken on subscription and released on teardown, so it is never held by a stream
    // whose client left before the handler finished.
    return new Observable<MessageEvent>((subscriber) => {
      if (!this.hub.acquire(userId)) {
        subscriber.next({ type: 'error', data: 'Too many open live-update connections.' });
        subscriber.complete();
        return undefined;
      }
      let closed = false;
      let unsubscribe: (() => Promise<void>) | null = null;
      const unregister = this.hub.onShutdown(() => {
        subscriber.complete();
      });
      const heartbeat = setInterval(() => {
        subscriber.next({ type: 'ping', data: '' });
      }, HEARTBEAT_MS);
      const recheck = setInterval(() => {
        this.auth.isStreamSessionCurrent(sessionId, session).then(
          (current) => {
            if (!current) subscriber.complete();
          },
          () => {
            subscriber.complete();
          },
        );
      }, SESSION_RECHECK_MS);
      this.hub
        .subscribe(channels, (event) => {
          subscriber.next({ type: 'change', data: event });
        })
        .then(
          (release) => {
            if (closed) {
              void release();
              return;
            }
            unsubscribe = release;
            subscriber.next({ type: 'ready', data: {} });
          },
          (error: unknown) => {
            subscriber.error(error);
          },
        );
      return () => {
        closed = true;
        unregister();
        clearInterval(heartbeat);
        clearInterval(recheck);
        this.hub.release(userId);
        if (unsubscribe !== null) {
          void unsubscribe();
        }
      };
    });
  }
}
