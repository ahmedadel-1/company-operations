import { allowInsecureRequests } from 'openid-client';
import type { Configuration } from 'openid-client';

/**
 * Plain-http issuer support for the local Keycloak only. Reachable only when
 * OIDC_ALLOW_INSECURE_HTTP=true, which the environment schema rejects in production.
 */
export const insecureDevTransport: readonly ((config: Configuration) => void)[] = [allowInsecureRequests];
