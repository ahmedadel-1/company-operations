import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

/** Same image and digest as infra/compose/docker-compose.dev.yml (DEPENDENCIES §6). */
const KEYCLOAK_IMAGE =
  'quay.io/keycloak/keycloak:26.8.0@sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc';

const realmFile = join(
  import.meta.dirname,
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
  readonly container: StartedTestContainer;
}

/** Keycloak in dev mode importing the repository realm exactly as Compose does (`start-dev --import-realm`). */
export async function startKeycloak(options: {
  appPublicUrl: string;
  backchannelLogoutUrl: string;
}): Promise<StartedKeycloak> {
  const clientSecret = randomBytes(24).toString('hex');
  const demoPassword = `Demo-${randomBytes(12).toString('hex')}`;
  const container = await new GenericContainer(KEYCLOAK_IMAGE)
    .withCommand(['start-dev', '--import-realm'])
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: 'e2e-admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: randomBytes(12).toString('hex'),
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
  return { baseUrl, issuer: `${baseUrl}/realms/company-ops`, clientSecret, demoPassword, container };
}
