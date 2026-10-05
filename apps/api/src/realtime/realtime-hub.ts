import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BeforeApplicationShutdown, OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';

import type { RealtimeEvent } from '@company-ops/core';
import { realtimeEventSchema } from '@company-ops/validation';

import { REDIS } from '../infrastructure/infrastructure.module.js';

export const MAX_STREAMS_PER_USER = 5;

type Listener = (event: RealtimeEvent) => void;

/**
 * Fans Redis pub/sub messages out to open SSE streams. One subscriber connection per API process;
 * a channel is subscribed while at least one stream listens to it. Channel names are built only by
 * the server from the stream's own session (`rt:org:<org>:user:<user>`, `rt:org:<org>:perm:<key>`),
 * so a stream can never listen to another tenant or user. Messages carry identifiers only.
 */
@Injectable()
export class RealtimeHub implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeHub.name);
  private subscriber: Redis | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly streams = new Map<string, number>();
  private readonly closers = new Set<() => void>();
  private draining = false;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  hasCapacity(userId: string): boolean {
    return !this.draining && (this.streams.get(userId) ?? 0) < MAX_STREAMS_PER_USER;
  }

  /** Reserves one of the user's stream slots; false when the user already has the maximum open. */
  acquire(userId: string): boolean {
    const open = this.streams.get(userId) ?? 0;
    if (this.draining || open >= MAX_STREAMS_PER_USER) {
      return false;
    }
    this.streams.set(userId, open + 1);
    return true;
  }

  release(userId: string): void {
    const open = (this.streams.get(userId) ?? 1) - 1;
    if (open <= 0) {
      this.streams.delete(userId);
    } else {
      this.streams.set(userId, open);
    }
  }

  async subscribe(channels: readonly string[], listener: Listener): Promise<() => Promise<void>> {
    const subscriber = this.connection();
    const added: string[] = [];
    for (const channel of channels) {
      let set = this.listeners.get(channel);
      if (set === undefined) {
        set = new Set();
        this.listeners.set(channel, set);
        await subscriber.subscribe(channel);
      }
      set.add(listener);
      added.push(channel);
    }
    return async () => {
      for (const channel of added) {
        const set = this.listeners.get(channel);
        set?.delete(listener);
        if (set?.size === 0) {
          this.listeners.delete(channel);
          await subscriber.unsubscribe(channel).catch((error: unknown) => {
            this.logger.warn({ err: error }, 'Realtime unsubscribe failed');
          });
        }
      }
    };
  }

  /**
   * Registers a stream to be ended when the process shuts down; returns the unregister function. Open
   * streams would otherwise keep the HTTP server from closing until the container is killed; browsers
   * reconnect to another instance on their own.
   */
  onShutdown(close: () => void): () => void {
    this.closers.add(close);
    return () => {
      this.closers.delete(close);
    };
  }

  beforeApplicationShutdown(): void {
    this.draining = true;
    for (const close of [...this.closers]) {
      close();
    }
    this.closers.clear();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
  }

  private connection(): Redis {
    if (this.subscriber === null) {
      // Unlike the request-path client, the subscriber queues SUBSCRIBE until connected and resubscribes
      // after a reconnect.
      const subscriber = this.redis.duplicate({
        lazyConnect: false,
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
      });
      subscriber.on('error', (error: Error) => {
        this.logger.warn({ err: error }, 'Realtime subscriber connection error');
      });
      subscriber.on('message', (channel: string, message: string) => {
        this.dispatch(channel, message);
      });
      this.subscriber = subscriber;
    }
    return this.subscriber;
  }

  private dispatch(channel: string, message: string): void {
    const listeners = this.listeners.get(channel);
    if (listeners === undefined) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.logger.warn({ channel }, 'Dropped malformed realtime message');
      return;
    }
    const event = realtimeEventSchema.safeParse(parsed);
    if (!event.success) {
      this.logger.warn({ channel }, 'Dropped malformed realtime message');
      return;
    }
    for (const listener of listeners) {
      listener(event.data);
    }
  }
}
