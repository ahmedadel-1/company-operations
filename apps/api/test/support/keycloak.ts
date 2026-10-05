import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { GenericContainer, Wait } from 'testcontainers';

/** Same image and digest as infra/compose/docker-compose.dev.yml. */
export const KEYCLOAK_TEST_IMAGE =
  'quay.io/keycloak/keycloak:26.8.0@sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc';

const realmFile = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'infra',
  'docker',
  'keycloak',
  'realms',
  'company-ops-realm.json',
);

export interface StartedKeycloak {
  readonly baseUrl: string;
  readonly issuer: string;
  readonly clientSecret: string;
  readonly demoPassword: string;
  adminToken(): Promise<string>;
  stop(): Promise<void>;
}

/**
 * Keycloak 26.8.0 in dev mode importing the repository realm file exactly as Compose does
 * (`start-dev --import-realm`, placeholders from the environment).
 */
export async function startKeycloak(options: {
  appPublicUrl: string;
  backchannelLogoutUrl: string;
}): Promise<StartedKeycloak> {
  const adminPassword = randomBytes(12).toString('hex');
  const clientSecret = randomBytes(24).toString('hex');
  const demoPassword = `Demo-${randomBytes(12).toString('hex')}`;
  const container = await new GenericContainer(KEYCLOAK_TEST_IMAGE)
    .withCommand(['start-dev', '--import-realm'])
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: 'test-admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      KC_HEALTH_ENABLED: 'true',
      OIDC_CLIENT_SECRET: clientSecret,
      KC_DEMO_USER_PASSWORD: demoPassword,
      APP_PUBLIC_URL: options.appPublicUrl,
      OIDC_BACKCHANNEL_LOGOUT_URL: options.backchannelLogoutUrl,
    })
    .withCopyFilesToContainer([{ source: realmFile, target: '/opt/keycloak/data/import/company-ops-realm.json' }])
    .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
    .withExposedPorts(8080, 9000)
    .withWaitStrategy(Wait.forHttp('/health/ready', 9000).forStatusCode(200))
    .withStartupTimeout(240_000)
    .start();
  const baseUrl = `http://localhost:${String(container.getMappedPort(8080))}`;
  return {
    baseUrl,
    issuer: `${baseUrl}/realms/company-ops`,
    clientSecret,
    demoPassword,
    adminToken: async () => {
      const response = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: 'test-admin',
          password: adminPassword,
        }),
      });
      const body = (await response.json()) as { access_token?: string };
      if (body.access_token === undefined) {
        throw new Error(`Keycloak admin token request failed (${String(response.status)})`);
      }
      return body.access_token;
    },
    stop: async () => {
      await container.stop();
    },
  };
}

/** Minimal cookie jar keyed by cookie name (single host per jar). */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (pair === undefined || index < 0) {
        continue;
      }
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === '' || /max-age=0/i.test(header) || /expires=thu, 01 jan 1970/i.test(header)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

const decodeHtml = (value: string): string =>
  value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');

export interface HtmlForm {
  readonly action: string;
  readonly fields: Record<string, string>;
}

/** The first form on a Keycloak page: its action and hidden inputs. */
export function parseForm(html: string): HtmlForm {
  const form = /<form\b[^>]*\baction="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (form?.[1] === undefined) {
    throw new Error('No form found on the Keycloak page.');
  }
  const fields: Record<string, string> = {};
  for (const input of (form[2] ?? '').matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0];
    const type = /\btype="([^"]*)"/i.exec(tag)?.[1] ?? 'text';
    const name = /\bname="([^"]*)"/i.exec(tag)?.[1];
    const value = /\bvalue="([^"]*)"/i.exec(tag)?.[1] ?? '';
    if (name !== undefined && type.toLowerCase() === 'hidden') {
      fields[name] = decodeHtml(value);
    }
  }
  return { action: decodeHtml(form[1]), fields };
}

/** RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s) as configured in the realm OTP policy. */
export function totp(secret: Buffer, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}
