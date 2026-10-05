/**
 * Fixed ports (overridable) so the Playwright config, global setup and the Keycloak realm (whose
 * redirect URIs embed the web origin) agree without passing state between processes.
 */
const webPort = Number(process.env.E2E_WEB_PORT ?? '3210');
const apiPort = Number(process.env.E2E_API_PORT ?? '4210');

export const E2E_WEB_PORT = webPort;
export const E2E_API_PORT = apiPort;
export const E2E_WEB_URL = `http://localhost:${String(webPort)}`;
export const E2E_API_URL = `http://localhost:${String(apiPort)}`;
