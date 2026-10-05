# Runbook: TLS and the reverse proxy

nginx 1.30 (`infra/nginx/prod/`) is the only published service. It terminates TLS, routes `/` to the web
app, `/api/` to the API and `/auth/` to Keycloak, and applies coarse per-IP limits in front of the
application's own rate limits (ADR-0016).

## Certificates

Put the certificate chain and key in `OPS_TLS_DIR` (default `/etc/company-ops/tls`):

| File | Content | Owner / mode |
|---|---|---|
| `fullchain.pem` | leaf + intermediates | `root:root 0644` |
| `privkey.pem` | private key (RSA 2048+ or ECDSA P-256) | `root:root 0600` |

The nginx master process runs as root inside its container and reads the key before dropping to the
`nginx` user, so the key never needs to be world-readable. The subject (SAN) must be
`OPS_PUBLIC_HOST`. Connections for any other name, or without SNI, are refused during the handshake
(`ssl_reject_handshake`). Government and enterprise customers often provide their own CA. Use their
chain as `fullchain.pem` in that case. The API reaches Keycloak at the public URL through this proxy,
so it must trust that CA too. Put the CA certificate in `OPS_SECRETS_DIR/private_ca.pem` (mode 0444)
and add `-f infra/compose/docker-compose.prod.private-ca.yml`. It sets `NODE_EXTRA_CA_CERTS` for the API
and worker, which also covers object storage, SMTP or a managed database signed by the same CA. The
rehearsal runs this way, with its self-signed certificate.

### Let's Encrypt (HTTP-01)

Port 80 serves `/.well-known/acme-challenge/` from `OPS_ACME_WEBROOT` and redirects everything else.
With certbot on the host:

```bash
certbot certonly --webroot -w /var/lib/company-ops/acme -d ops.example.com \
  --deploy-hook /usr/local/sbin/company-ops-install-cert
```

```bash
#!/usr/bin/env bash
# /usr/local/sbin/company-ops-install-cert: copy (certbot's live/ files are symlinks) and reload.
set -euo pipefail
install -m 0644 -o root -g root "$RENEWED_LINEAGE/fullchain.pem" /etc/company-ops/tls/fullchain.pem
install -m 0600 -o root -g root "$RENEWED_LINEAGE/privkey.pem" /etc/company-ops/tls/privkey.pem
cd /opt/company-ops && docker compose --env-file /etc/company-ops/compose.env \
  -f infra/compose/docker-compose.prod.yml exec -T proxy nginx -s reload
```

For the very first certificate the proxy cannot start without a certificate. Start it once with a
temporary self-signed pair
(`openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=<host> -addext subjectAltName=DNS:<host> -keyout privkey.pem -out fullchain.pem`),
then run certbot. The renewal timer certbot installs runs the deploy hook. Renewal is not rehearsed,
because a workstation cannot obtain public certificates. The reload command is.

### Expiry monitoring

Alert 21 days before expiry, for example with the uptime monitor's certificate check or
`openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -enddate`.

## TLS settings

Mozilla *intermediate* profile: TLS 1.2 and 1.3 only, forward-secret AEAD ciphers, server cipher
preference off, session tickets off (no long-lived ticket key to protect), 10 MB shared session cache.
The smoke test checks that TLS 1.1 and unknown server names are refused. HTTP/2 is on. HTTP/3 is not
configured.

## HSTS and preload

Every HTTPS response, including the proxy's own error responses, carries
`Strict-Transport-Security: max-age=63072000; includeSubDomains`. `includeSubDomains` affects every name
below `OPS_PUBLIC_HOST`. Deploy on a dedicated name (for example `ops.example.com`) rather than the
organization's apex domain. **Do not add `preload`** unless every subdomain of the registrable domain
is HTTPS-only for good. Removal from browser preload lists takes months.

## Routing and limits

| Path | Upstream | Limits |
|---|---|---|
| `/api/v1/notifications/events/stream` | API | no buffering, 120 s read timeout (heartbeat every 25 s) |
| `/api/v1/webhooks/` | API | 20 r/s per IP (burst 100), body up to 6 MB |
| `/api/v1/auth/login`, `/callback` | API | 30 r/min per IP (burst 20) |
| `/api/v1/docs` | none | always 404 |
| `/api/` | API | 50 r/s per IP (burst 200), body 1 MB |
| `/auth/admin/`, `/auth/realms/master/` | none | always 404 (administration over SSH tunnel only) |
| `/auth/` | Keycloak | 10 r/s per IP (burst 50) |
| `/` | web | 50 r/s per IP (burst 200) |

Plus 100 concurrent connections per IP, 15 s header and 30 s body timeouts. Uploads do not pass
through the proxy: browsers upload directly to object storage with pre-signed URLs. Limit rejections
are `429` with `Retry-After` and the API's JSON error envelope (rehearsed: 227 served and 373 limited
in a burst of 600, all with `Retry-After`).

When an upstream is unreachable (restart, deploy, outage), the proxy answers `503` with `Retry-After`.
API paths get the `DEPENDENCY_UNAVAILABLE` JSON envelope, and pages get a static bilingual page with a
`default-src 'none'` CSP. Responses the applications produce themselves pass through unchanged.

## Client addresses

The proxy **overwrites** `X-Forwarded-For` with the connecting address (`snippets/proxy-headers.conf`),
and the API trusts exactly one hop (`TRUST_PROXY_HOPS=1`). A client cannot spoof its address for rate
limits or audit records. If another load balancer or CDN terminates connections in front of this
proxy, every client then appears as that balancer's address. Configure nginx's `real_ip` module
(`set_real_ip_from <balancer network>; real_ip_header X-Forwarded-For;`) in a template override
**before** going live, and never expose the API port directly.

## Logs

JSON access log on stdout without query strings (`$uri`), so OIDC codes, `state` and pre-signed URL
signatures never reach the log. Each line carries the `request_id` that the API also logs
(`X-Request-Id`), which correlates a proxy line with the application's lines.

## Operations

- Validate the configuration: `dc exec proxy nginx -t`.
- Reload after certificate or template changes: `dc exec proxy nginx -s reload`. Template changes need
  `dc up -d --force-recreate proxy`, because templates are rendered at container start.
- The container runs with a read-only root filesystem, all capabilities dropped except
  `NET_BIND_SERVICE`, `SETUID`, `SETGID` and `CHOWN`, and `no-new-privileges`.
