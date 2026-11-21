# Production: one personal workspace

The application has no built-in login or password protection. Each deployment
is one shared personal workspace: anyone who can access its URL can view its
history and settings and, outside demo mode, change settings and use configured
provider accounts. There are no individual accounts or ownership boundaries.
Production uses HTTPS, explicit persistent storage/execution configuration and
deliberate generation enablement.

## Public demo

To publish a read-only interface demo, set `APP_DEMO_MODE=true`,
`GENERATION_ENABLED=false`, and `APP_ORIGIN` to its exact HTTPS origin. All
workspace write requests are rejected before parsing inputs or contacting
providers; visitors can browse the Studio and provider settings but cannot save
keys, upload, generate or change shared data. Existing history and provider
metadata remain visible, so use a separate empty database and no provider
credentials for the demo. The storage/execution configuration below still
applies. Redeploy after changing the environment. Personal functional deployments
leave demo mode off; they also have no application login.

Vercel Blob and S3 default to private originals with expiring, scoped links for
browsers and AI providers. The app's media routes issue those links without a
login. Legacy Cloudinary originals remain public by URL. See [storage](storage.md).

## Common configuration

Use platform secrets or a restricted environment file, never `NEXT_PUBLIC_*`,
logs or command-line arguments. Replace the placeholders below:

```dotenv
APP_ORIGIN=https://studio.example.com
GENERATION_ENABLED=false
TASK_OBSERVATION_TIMEOUT_MS=86400000
# Required before saving connections from /<locale>/settings.
PROVIDER_CONFIG_ENCRYPTION_KEY=<independent-random-secret-at-least-32-characters>
```

The origin is exactly HTTPS without trailing slash or path. Mutations require
the exact browser Origin; missing/null origins and untrusted sibling sites are
denied. Forwarded host/IP headers do not grant authority. Local development can
use an HTTP loopback origin. `npm run dev` binds to `127.0.0.1` by default.

Configure provider-side hard quotas/budgets where offered and billing alerts
before enabling generation. Alerts are not hard caps. Review model prices and
output counts. `GENERATION_ENABLED=false` stops new submissions, including queued
tasks that have not reached their provider, while history, downloads and existing
task observation remain available. It is a kill switch, not a money counter.
Reload/redeploy after environment changes.

## Persistent single process

```dotenv
DEPLOYMENT_PROFILE=single-process
TASK_WORKER_MODE=local
ASSET_STORAGE_MODE=local
OPEN_HIGGSFIELD_STORAGE_DIR=/app/data
```

Leave `DATABASE_URL` unset for local task history. Mount a persistent disk at
the absolute path and run exactly one Node process: no PM2 cluster, multiple
containers, replicas or ephemeral volume. Configuration cannot prove a durable
mount. PostgreSQL, even on one server, requires durable object storage (Blob, S3 or
legacy Cloudinary).

Startup validates configuration/store and starts the ten-second local observer.
A supervisor must restart the process after failure. Restart reloads due tasks
and never resubmits generation. Docker Compose uses `restart: unless-stopped`,
mounts `/app/data`, and publishes the HTTP port on loopback. Expose only the TLS
reverse proxy publicly. Configure production settings before starting Docker.

## Docker on Windows

The repository ships a multi-stage `Dockerfile` (Node 22 Alpine, standalone
output, non-root uid 1001) and a `docker-compose.yml` that reads `.env.local`,
publishes `127.0.0.1:3000`, and mounts the named volume
`open-higgsfield-data` at `/app/data`. The image already sets
`OPEN_HIGGSFIELD_STORAGE_DIR=/app/data`, so the volume and the storage root are
the same directory.

Prerequisites: Docker Desktop with the WSL 2 backend, the repository checked out
on a shared drive (Docker Desktop shares `C:` by default), and a completed
`.env.local` with `APP_ORIGIN` set to the HTTPS origin of your reverse proxy —
not `http://localhost:3000`. Run the commands from the repository root in
PowerShell.

```powershell
docker compose up --build -d
docker compose ps
docker compose logs -f open-higgsfield
```

Verify liveness and that the container can reach ComfyUI before enabling real
work:

```powershell
curl.exe -s http://127.0.0.1:3000/api/health
docker compose exec open-higgsfield wget -qO- http://100.92.10.72:8188/system_stats
```

The second command is the important one on Windows: the container reaches the
GX10 through Docker Desktop's NAT and the host's Tailscale routes. If it fails,
the container has no route to `100.92.10.72` even though the host can reach it;
check `tailscale status` on the host, the Windows firewall profile for the
Docker network, and whether the endpoint is reachable from a container at all.
Do not change the saved ComfyUI base URL to a public address to work around a
routing problem.

Stop and start without deleting data:

```powershell
docker compose stop
docker compose start
docker compose down          # removes the container, keeps the volume
docker compose down -v       # DESTROYS the data volume - never on a live workspace
```

Notes:

- Compose prefixes named volumes with the project name, which defaults to the
  checkout directory (`lh-docs_open-higgsfield-data` here). Confirm the actual
  name with `docker volume ls` before backing it up.
- The application runs as uid 1001 inside the image. Files in the volume are
  owned by that user; mount or copy them with the same ownership.
- The container does not need a GPU and does not run ComfyUI. Generation stays on
  the GX10.

These commands were **not executed on the documentation host**: Docker Desktop
is not installed there. They are derived from this repository's `Dockerfile` and
`docker-compose.yml` and from standard Docker behaviour, not from an observed
run.

## Backup and restore

Back up three things, and keep the secrets out of the data archive:

1. **The data root** — task history, `uploads/`, `downloads/`, `library/`.
   In the single-process and Docker profiles this is the whole workspace state.
2. **`PROVIDER_CONFIG_ENCRYPTION_KEY`** — without it, provider connections saved
   through the interface cannot be decrypted. Store it in a password manager,
   not in the same archive as the data.
3. **The environment file** (`.env.local` or platform secrets) — contains
   provider credentials and `APP_ORIGIN`.

Losing the key is not data loss for media or history, but every saved connection
must be deleted and re-added, and any provider-side state you cannot recreate is
gone. Replacing the key has the same effect.

### Docker volume

Stop the container first so files are not changing during the copy, then archive
the volume from a throwaway container. Replace the volume name with the one from
`docker volume ls`.

```powershell
docker compose stop
docker run --rm --user 1001:1001 -v lh-docs_open-higgsfield-data:/data -v C:/backups:/backup alpine tar czf /backup/lh-video-data.tar.gz -C /data .
docker compose start
```

Restore into the same volume:

```powershell
docker compose down
docker run --rm --user 1001:1001 -v lh-docs_open-higgsfield-data:/data -v C:/backups:/backup alpine sh -c "find /data -mindepth 1 -delete && tar xzf /backup/lh-video-data.tar.gz -C /data"
docker compose up -d
```

If the archive was written by another user, restore as root and then fix
ownership: `docker run --rm -v <volume>:/data alpine chown -R 1001:1001 /data`.

After restoring, start with `GENERATION_ENABLED=false`, check `/api/ready`,
confirm history and the library appear, and open **Providers** to confirm saved
connections decrypt (that proves the key matches). Re-enable generation only
after those checks.

### Desktop data folder

The Windows build uses the same layout, with the folder chosen at first launch:

- Default: `Documents\LH Video Data`; any folder can be selected.
- Recorded as `dataDir` in `%LOCALAPPDATA%\LH Video\config.ini`, next to the
  generated `encryptionKey`. The launcher passes the folder to the app as
  `OPEN_HIGGSFIELD_STORAGE_DIR`.
- `config.ini` holds the key in plain text. Treat it as a secret and keep it out
  of shared or synced folders.
- Back up by closing LH Video and copying the data folder plus `config.ini`.
- Restore by installing the same or a newer version, copying the data folder
  back, then choosing it in the folder dialog, editing `dataDir` in `config.ini`,
  or launching `LHVideo.exe --data-dir "D:\LH Video Data"`. Keep the original
  `encryptionKey` line from the backup.
- Uninstalling removes `%LOCALAPPDATA%\LH Video`, including `config.ini` and the
  key, but leaves the chosen data folder untouched. Copy `config.ini` before
  uninstalling if the connections must remain decryptable.

The restore sequence is the same as the Docker one: start with generation
disabled, verify readiness, history, library and connection decryption, then
re-enable. The Docker commands above were not executed on this host; the desktop
paths and behaviour are taken from `packaging/launcher.cs` and
`packaging/installer.nsi`.

## Vercel and distributed execution

Set the common settings and:

```dotenv
DEPLOYMENT_PROFILE=distributed
TASK_WORKER_MODE=workflow
DATABASE_URL=<postgresql-or-neon-connection-string>
ASSET_STORAGE_MODE=vercel-blob
ASSET_DELIVERY_MODE=private
# Vercel supplies BLOB_STORE_ID and VERCEL_OIDC_TOKEN for a connected store.
# BLOB_READ_WRITE_TOKEN=<static-token-for-local-or-non-Vercel-hosts>
```

S3 is also supported; see [media storage](storage.md) for settings and credentials.
Vercel rejects local file/asset/worker profiles. PostgreSQL is authoritative with
no file fallback or runtime DDL. Apply the explicit migration before starting.

Enable Fluid compute and access to System Environment Variables in the Vercel
project settings; the SDK needs `VERCEL_DEPLOYMENT_ID` to select its Vercel World.
The application rejects non-Vercel Workflow targets in production. Next config
uses the official `withWorkflow` plugin. No minute Cron, GitHub scheduler,
`CRON_SECRET` or `TASK_SCHEDULER_CONFIGURED` is required for this profile.

The request saves an inactive queued task, waits for durable Workflow admission,
then activates it and returns HTTP 202. The Workflow submits once, observes the
saved operation and stores outputs after the browser closes. SQL leases and
revisions fence duplicate delivery. Unknown submission outcomes are never
resubmitted automatically. Inputs use stable media routes; signing happens just
before submission. Workflow event arguments/results exclude prompts and secrets.
See [background execution](background-execution.md) for deadlines, retries,
recovery and costs. Free allowances are finite and AI credits remain separate.

The SDK's generated `/.well-known/workflow/*` queue handlers validate their own
delivery credentials. Preserve this integration and verify delivery with any
Deployment Protection settings. `/api/ready` deliberately reports
`workflow_execution: "unverified"`; validate an actual synthetic run on Vercel.

### Optional external workers on another host

Keep `TASK_WORKER_MODE=external`, a random `CRON_SECRET` of 32-256 printable
non-space ASCII characters and
`TASK_SCHEDULER_CONFIGURED=true` only when installing a separate recurring
trigger. `/api/internal/process-tasks` accepts the Bearer scheduler credential. It rejects
HEAD/query overrides, claims at most ten tasks and has a fifty-second work budget
under `maxDuration=60`. Generation routes retain `maxDuration=300` and a
270-second entry budget. Workflow steps have a bounded 240-second work budget.
The declaration does not prove recurring delivery. Timers/Next `after` alone do
not provide durable serverless recovery. The repository does not install a Cron.

On another platform, a systemd timer can invoke the same HTTPS endpoint:

```ini
# open-higgsfield-poll.service
[Service]
Type=oneshot
ExecStart=/usr/bin/curl --config /etc/open-higgsfield/cron.curl
TimeoutStartSec=60
```

```ini
# open-higgsfield-poll.timer
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
Persistent=true
[Install]
WantedBy=timers.target
```

Keep the curl config readable only by the service identity (mode 0600):

```text
url = "https://studio.example.com/api/internal/process-tasks"
header = "Authorization: Bearer <scheduler-secret>"
fail-with-body
silent
show-error
max-time = 55
```

Do not use retry flags, follow redirects or print authorization. This example
does not install a timer or claim one is running. It needs the external-worker
profile and a separately supervised, available application.

## Ingress and request limits

Direct generation attachments and fields together must fit under **4 MiB**,
including multipart framing. Actual streamed bytes are counted, at most sixteen
files and 128 fields are allowed, each string field is bounded to 64 KiB, and body
reads expire after thirty seconds. Use supported public HTTPS reference URLs for
larger videos. Remote/generated-media bounds are separate. There is no direct
browser-to-object-store upload flow. Gallery JSON is limited to 16 KiB; task
resume/delete accepts empty bodies only.

Configure ingress rate controls separately. NGINX can define a global zone in
its `http` block, avoiding dependence on claimed client IP headers:

```nginx
limit_req_zone $server_name zone=workspace_generation:1m rate=6r/m;
```

In the HTTPS server:

```nginx
location ~ ^/api/generate(-image)?$ {
    limit_req zone=workspace_generation burst=2 nodelay;
    limit_req_status 429;
    client_max_body_size 4m;
    client_body_timeout 30s;
    proxy_read_timeout 310s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:3000;
}
```

Add actual TLS certificates, normal application proxy locations and SSE
buffering settings. Vercel operators can configure documented WAF rate rules.
Neither example is automatically installed or establishes a monetary limit.
Use platform ingress controls against credential guessing and availability abuse.

## Activation, monitoring and recovery

1. Back up task/media data and stop every old web/worker writer; old writers
   ignore revisions/tombstones. Keep generation disabled.
2. After separate production authorization, apply
   `migrations/0001_durable_task_lifecycle.sql`,
   `migrations/0002_provider_runtime_catalog.sql` and
   `migrations/0003_workflow_queue.sql`, in that order when missing, with
   `psql -X -v ON_ERROR_STOP=1`.
   Supply the connection through a restricted PostgreSQL service/env file;
   never print it. Legacy file history is normalized by the new reader. Do not
   bulk-upload old media during startup. Task schema version is now 3; do not
   reapply older migration 0001 after the forward migration.
3. Configure HTTPS and one supported profile. Missing configuration/schema
   stops startup with `ERR_STARTUP_CONFIGURATION_OR_STORAGE`; there is no open
   fallback. A production build does not need runtime secrets.
4. Verify pages, lists, events and media routes load without login. Verify
   cross-origin/missing-Origin mutations are denied. In demo mode, all workspace
   writes must be denied, including generation and provider configuration.
   Public `GET /api/health` returns only `{"status":"alive"}`.
5. `/api/ready` validates configuration and performs a current task
   store read. Workflow mode reports `scheduler_heartbeat:"not_applicable"` and
   `workflow_execution:"unverified"`. Verify a synthetic Workflow on the target
   deployment. For external mode, verify recurring scheduler delivery instead.
   After switching profiles, POST an empty body to
   `/api/internal/reconcile-workflows` with exact Origin to arm observers for
   previously accepted tasks (at most 20 per call; follow `nextCursor` via
   `?after=<nextCursor>`). Duplicate runs are safe for
   provider spending but consume extra Workflow events.
6. Monitor Workflow runs/failures and usage (or `[task-scheduler]` in external
   mode), old pending tasks, storage errors and recovery-
   required tasks. Logs contain only timings/counts/safe codes. Do not add raw
   upstream bodies, prompts, URLs or secrets. Monitoring is not provisioned here.
7. Confirm durable storage and the chosen delivery policy and provider quotas, then explicitly
   enable `GENERATION_ENABLED=true` and reload. Paid smoke tests or real uploads
   require separate authorization; local checks do not perform them.

The UI fences repeated click/Enter while sending. Ambiguous HTTP 202, incomplete
storage, invalid responses and lost connections display a do-not-resubmit
warning and require explicit acknowledgement that task status was checked.
Acknowledgement sends nothing. Check history and provider records first: the
original request may already be running or charged.

Observation defaults to 24 hours (range 30 minutes to 7 days). Deadline/query failures
pause observation without asserting provider failure. After repairing the cause,
`POST /api/tasks/:id` or `/api/image-tasks/:id` with exact Origin and
empty body resumes only a paused task with a saved operation; it never repeats
generation. Unknown submissions without an operation need provider reconciliation.
Deleting a task fences worker writes but does not cancel provider generation or
automatically delete media. Tombstone/object retention needs an operator policy.

Rollback first disables generation and stops workers. Preserve the new writer/
storage contract, or restore matching app/data backups with reconciliation of
jobs accepted since backup. Do not run old writers against migrated live state
or delete durable objects merely to roll back code.

## Official references and local evidence

- [Next.js instrumentation](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation)
- [Workflow integration](https://workflow-sdk.dev/docs/getting-started/next),
  [deployment](https://workflow-sdk.dev/docs/deploying),
  [pricing](https://vercel.com/docs/workflows/pricing) and
  [function limits](https://vercel.com/docs/functions/limitations)
- [OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [NGINX limits](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html) and
  [Vercel WAF](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)

Local synthetic tests do not establish production TLS/Workflow delivery, disk mount
durability, real Blob/S3/Cloudinary delivery or configured provider quotas.
