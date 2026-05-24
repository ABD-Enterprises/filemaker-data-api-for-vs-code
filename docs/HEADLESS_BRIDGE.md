# Headless FileMaker Bridge

The headless bridge image runs the embedded `fmBridgeServer` without VS Code. Use it when automation needs the same bridge routes from CI pipelines, scheduled jobs, or a controlled gateway service between FileMaker and other tools.

The release image is published to:

```text
ghcr.io/abd-enterprises/filemaker-bridge
```

## Configuration

The container reads FileMaker connection settings from environment variables:

| Variable       | Required | Description                                                                                   |
| -------------- | -------: | --------------------------------------------------------------------------------------------- |
| `BRIDGE_PORT`  |       No | HTTP port inside the container. Defaults to `8080`.                                           |
| `FM_SERVER`    |      Yes | FileMaker Server or FileMaker Cloud base URL, such as `https://fm.example.com`.               |
| `FM_DATABASE`  |      Yes | Database name used for Data API requests.                                                     |
| `FM_USER`      |      Yes | Direct Data API username.                                                                     |
| `FM_PASS_FILE` |      Yes | Path to a mounted file containing the FileMaker password.                                     |
| `BRIDGE_TOKEN` |       No | Stable token for bridge clients. If omitted, the bridge generates one and logs it at startup. |

Use a mounted secret for `FM_PASS_FILE`; do not pass the FileMaker password as a plain environment variable.

## Run Locally

```bash
docker run --rm \
  -p 8080:8080 \
  -e BRIDGE_PORT=8080 \
  -e BRIDGE_TOKEN="$(openssl rand -hex 32)" \
  -e FM_SERVER=https://fm.example.com \
  -e FM_DATABASE=Operations \
  -e FM_USER=automation \
  -e FM_PASS_FILE=/run/secrets/fm-password \
  -v "$PWD/.secrets/fm-password:/run/secrets/fm-password:ro" \
  ghcr.io/abd-enterprises/filemaker-bridge:v1.1.0
```

Check startup:

```bash
curl -fsS http://127.0.0.1:8080/healthz
```

Run a script through the bridge:

```bash
curl -fsS http://127.0.0.1:8080/fm/runScript \
  -H "Content-Type: application/json" \
  -H "X-FM-Bridge-Token: $BRIDGE_TOKEN" \
  --data '{"layout":"Jobs","scriptName":"Run_Scheduled_Job","scriptParam":"nightly"}'
```

## CI Pipelines

CI jobs can start the container as a service, mount the FileMaker password from the CI secret store, and call `/fm/runScript` or CRUD routes to seed data, validate migrations, or run acceptance scripts.

## Scheduled Jobs

Schedulers such as cron, GitHub Actions schedules, or Kubernetes CronJobs can run the image on a private network and execute a FileMaker script with a short-lived `BRIDGE_TOKEN`.

## Gateway Use

When a central automation host needs to broker FileMaker Data API access for other trusted internal tools, run the bridge behind private networking or a reverse proxy that enforces TLS and upstream authentication. The bridge token is still required on every `/fm/*` request.

## Validation

Build and smoke-test the image locally:

```bash
scripts/smoke-headless-bridge-image.sh
```

The smoke test builds the Docker image, starts it with a mounted password file and fake FileMaker connection settings, then verifies the `/healthz` endpoint.
