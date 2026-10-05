# Runbook: deploy, upgrade and roll back

Single Linux host running `infra/compose/docker-compose.prod.yml` (`DEPLOYMENT.md` §4). The procedure
was exercised on the production stack in the Phase 9 rehearsal (`scripts/release/rehearse.ts`) on
Docker Engine 26.1 / Compose 2.27. Not exercised there, because a workstation cannot: a publicly
trusted certificate and ACME renewal, `docker compose pull` from a registry, and real DNS (the rehearsal
uses a self-signed certificate, local images and a hosts-file style resolve).

## Requirements

| Item | Minimum | Notes |
|---|---|---|
| OS | 64-bit Linux (x86_64) | The images are built for `linux/amd64`. |
| Docker | Engine 24+ with Compose v2.20+ | `depends_on.required` needs Compose 2.20. Building images needs BuildKit (default since Engine 23). |
| CPU / RAM | 4 vCPU / 8 GB | Container memory limits add up to about 6 GB (API 1 GB, worker 1 GB, web 512 MB, Keycloak 1.5 GB, Redis 768 MB, PostgreSQL shared buffers 512 MB). 16 GB recommended. |
| Disk | 40 GB SSD plus backups | PostgreSQL volume, Redis AOF, local backups (copy them off the host). |
| Network | 80 and 443 inbound; outbound HTTPS to object storage (and SMTP, Jira, GitHub when enabled) | Nothing else is published. Keycloak administration binds to `127.0.0.1` only. |
| DNS | `OPS_PUBLIC_HOST` points to the host | Needed for certificates and for OIDC (the API resolves the public issuer to the host's proxy). |
| Object storage | S3-compatible bucket with CORS for `APP_PUBLIC_URL` (`PUT`, `GET`, `content-type`) | External by design (ADR-0008). |

## Layout on the host

```text
/opt/company-ops/            release checkout (the repository at the release tag; only infra/ and scripts/ are used)
/etc/company-ops/            root:root 0700
  compose.env                0600, from infra/compose/compose.env.example
  app.env                    0600, from infra/compose/app.env.example
  secrets/                   0700, files 0444 (scripts/ops/init-secrets.sh, docs/runbooks/secrets.md)
  tls/                       fullchain.pem (0644), privkey.pem (0600) (docs/runbooks/tls-and-proxy.md)
/var/lib/company-ops/acme    ACME HTTP-01 webroot
/var/backups/company-ops     local backups (docs/runbooks/backup-restore.md)
```

All commands use this helper (add the overlays you enable, in this order):

```bash
cd /opt/company-ops
dc() {
  docker compose --env-file /etc/company-ops/compose.env \
    -f infra/compose/docker-compose.prod.yml \
    "$@"
}
# With email:            -f infra/compose/docker-compose.prod.smtp.yml
# With Jira / GitHub:    -f infra/compose/docker-compose.prod.jira.yml / ...github.yml (after live verification)
# With managed DB/Redis: -f infra/compose/docker-compose.prod.external-data.yml
# With a private CA:     -f infra/compose/docker-compose.prod.private-ca.yml
```

## Images

Build once per release from a clean checkout of the release commit, scan, then distribute by tag:

```bash
bash scripts/release/build-images.sh "$(git rev-parse --short=12 HEAD)" ghcr.io/<org>
```

The CI job `release-images` does the same, fails on fixable HIGH/CRITICAL vulnerabilities (Trivy,
`.trivyignore` for reviewed exceptions) and publishes CycloneDX SBOMs as build artifacts
(`SECURITY.md` §13). Never deploy `latest`; `OPS_VERSION` is the immutable tag. Hosts without registry
access can use `docker save ops/ops-api:<tag> ... | gzip` and `docker load`.

## First installation

1. **Files.** Create the layout above. Copy the two env examples, fill in host name, image tag, S3 and
   SMTP settings. `APP_PUBLIC_URL` must be identical in both files.
2. **Secrets.** `sudo bash scripts/ops/init-secrets.sh /etc/company-ops/secrets`, then write the object
   storage secret (`docs/runbooks/secrets.md` §Provisioning). The script exits 2 until it exists.
3. **TLS.** Install the certificate and key (`docs/runbooks/tls-and-proxy.md`).
4. **Validate.** `dc config --quiet` (fails on any missing variable or secret file).
5. **Data stores, then schema.**
   ```bash
   dc up -d --wait postgres redis
   dc --profile migrate run --rm migrate
   ```
   The first PostgreSQL start runs `infra/docker/postgres/prod-init` (roles `ops_migrator`, `ops_app`,
   `ops_backup`, `keycloak`; databases `company_ops`, `keycloak`). Migrations took 7 s on an empty
   database in the rehearsal. The migrate job prints `prisma:warn Prisma failed to detect the
   libssl/openssl version`: expected and harmless. The schema engine in the image links no OpenSSL
   (checked with `ldd`), so do not install OpenSSL into the image to silence it.
6. **Everything else.** `dc up -d --wait` (Keycloak's first start imports the production realm, which
   has no users; allow up to 2 minutes).
7. **Smoke test** from any machine with Node 24: `node scripts/release/smoke.ts --url https://<host> --http-port 80`.
   All 13 checks must pass (TLS versions, unknown server names, redirect, HSTS, readiness, response
   headers, CSP, immutable assets, OIDC with PKCE, public issuer, admin paths hidden, anonymous API
   refused).
8. **First administrator.**
   - Open an SSH tunnel `ssh -L 8090:127.0.0.1:8090 <host>` and sign in to
     `http://127.0.0.1:8090/auth/admin/` as `KC_BOOTSTRAP_ADMIN_USERNAME` with the
     `keycloak_admin_password` secret (`docs/runbooks/keycloak.md`).
   - In realm `company-ops`, create the person's user with a verified email and a **temporary**
     password (Keycloak forces a change at first sign-in), and hand it over separately from the
     invitation link. Self-service password reset is off in the production realm until SMTP is
     configured in Keycloak (`docs/runbooks/keycloak.md`).
   - Create the organization and its invitation inside the API container. The link is written to a
     file, never to the logs:
     ```bash
     dc exec -T api ops-bootstrap --slug acme --name "Acme Ltd" --time-zone Africa/Cairo \
       --work-week 7,1,2,3,4 --admin-name "Jane Admin" --admin-email jane@acme.example \
       --confirm-production acme --invitation-file /tmp/invitation
     dc exec -T api sh -c 'cat /tmp/invitation; rm -f /tmp/invitation'
     ```
   - Hand the link over through a channel you trust. At first sign-in the administrator must enrol a
     TOTP authenticator (ORG_ADMIN requires a second factor), then accepts the invitation.
   - Re-running `ops-bootstrap` changes nothing while an administrator is active. Use `--reissue` to
     replace an unused invitation.
9. **Backups.** Install the timer from `docs/runbooks/backup-restore.md` and run one backup by hand.
10. **Monitoring.** Point the external uptime check at `https://<host>/api/v1/health/ready` and set up
    scraping (`docs/runbooks/observability.md`).

## Upgrade (new release)

Releases use expand-only migrations (`DEPLOYMENT.md` §9), so the previous release keeps working on the
new schema and a rollback never needs a down-migration.

```bash
dc --profile backup run --rm backup                          # pre-deploy backup; copy it off the host
sed -i 's/^OPS_VERSION=.*/OPS_VERSION=<new tag>/' /etc/company-ops/compose.env
dc pull api worker web migrate                               # or docker load
dc --profile migrate run --rm migrate                        # old release keeps serving meanwhile
dc up -d --wait api worker web                               # recreates only changed services
node scripts/release/smoke.ts --url https://<host> --http-port 80
```

During `up` each container is replaced one at a time. The API stops taking traffic as soon as it
receives SIGTERM (readiness turns 503, open live-update streams are closed, the process exits within
the 30 s grace period; measured: stopped in 0.9–1.2 s with exit 143). The worker finishes or releases
its jobs within 45 s. With a single API container, the proxy answers API calls while it restarts with
a `503 DEPENDENCY_UNAVAILABLE` envelope, and pages with a static "temporarily unavailable" page. Both
carry `Retry-After`. For upgrades without that gap, run two API replicas (`dc up -d --scale api=2`). The
proxy re-resolves `api` through Docker DNS every 10 s and retries the other replica. In the rehearsal,
stopping and restarting one of two replicas under steady traffic produced 988 of 988 successful
responses.

Read the release notes for the release's required actions (new variables, one-time admin steps). The
application refuses to start on missing or invalid configuration and names the variable.

## Rollback

1. Set `OPS_VERSION` back to the previous tag and run `dc up -d --wait api worker web`.
2. Do **not** roll back migrations. The previous release runs on the expanded schema. A release that
   needs a contract step (dropping columns) says so and ships it one release later.
3. Smoke test.
4. Only after data corruption, restore the pre-deploy backup (`docs/runbooks/backup-restore.md`
   §Restore into production). Data written since then is lost, so this is the last resort.

## Rehearsal (workstation)

`node scripts/release/rehearse.ts up --version <tag>` runs this procedure against a throwaway
directory with random secrets, a self-signed certificate and a stand-in S3 (SeaweedFS), then
`smoke`, `journey` (first administrator through the browser, TOTP step-up, live updates, API drain),
`restore-drill`, `rotate` and `down --dir <dir>`. It is the executable form of this runbook. It never
targets a real host.

## Post-deploy checks

- `dc ps`: every service `healthy`.
- Smoke test: 13/13.
- `docker compose logs --since 10m api worker | grep '"level":50'`: no errors (pino level 50 = error).
- Worker metrics: `ops_outbox_oldest_pending_seconds` under 60 and no growing `ops_queue_jobs{state="failed"}`.

## Go-live checklist (first production launch)

Tick every item before announcing the service. The items marked *rehearsed* were exercised on the
production Compose stack during Phase 9. The others depend on the target host and cannot be checked
from the repository.

**Host and access**
- [ ] Host meets the requirements above; time synchronized (NTP); disk alerts configured.
- [ ] Firewall exposes only 80 and 443. SSH is key-only, and the Keycloak admin port is reachable only through the SSH tunnel.
- [ ] Real DNS name points at the host; a publicly trusted certificate is installed and its renewal tested (`tls-and-proxy.md`; ACME not rehearsed).

**Secrets and configuration**
- [ ] Secrets created with `init-secrets.sh` (rehearsed); off-host encrypted copy stored; `compose.env` and `app.env` are root-only `0600`.
- [ ] `dc config --quiet` passes with exactly the overlays in use.
- [ ] Bucket is private, its CORS is limited to `APP_PUBLIC_URL`, and versioning or replication is on (`backup-restore.md` §Object storage).
- [ ] SMTP relay uses TLS; one test email delivered.

**Release**
- [ ] Images built with an immutable tag; the CI Trivy gate is green and SBOMs are archived.
- [ ] Migrations applied (rehearsed); smoke test 13/13 (rehearsed).
- [ ] First administrator created with `ops-bootstrap --invitation-file` (rehearsed). The invitation file is deleted after use, the bootstrap Keycloak admin disabled or rotated, and TOTP enrolled (`keycloak.md`).
- [ ] Organization settings saved: time zone, work week, attendance accuracy policy, retention policies if required.

**Operations**
- [ ] Backup timer enabled; first backup verified; restore drill done on this host or a copy (rehearsed on the workstation).
- [ ] Uptime monitor on `/api/v1/health/ready` and `/healthz`; Prometheus scraping with the alert rules (`observability.md`).
- [ ] On-call contact and escalation agreed; runbooks reachable without the application.

**Integrations** (only if they will be enabled)
- [ ] Jira Cloud live checklist (`DEPLOYMENT.md` §6) passed against a controlled test site. Until then, do not add the Jira overlay. **This is a pre-production external blocker.**
- [ ] GitHub App live checklist passed against a test organization. Until then, do not add the GitHub overlay. **This is a pre-production external blocker.**
