# Vibe

A social networking platform (posts, feed, stories, real-time chat, notifications) built to demonstrate
production-grade backend engineering: indexed MongoDB access patterns, Redis caching, asynchronous
processing with BullMQ, and horizontally scalable real-time messaging.

**Design docs:** [architecture](docs/architecture.md) · [database design](docs/database-design.md) ·
[API design](docs/api-design.md) · [caching strategy](docs/caching-strategy.md) ·
[scalability](docs/scalability.md) · [engineering decisions](docs/engineering-decisions.md) ·
[interview notes](INTERVIEW_NOTES.md) (every subsystem, with the bugs found building it).
Build log: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## Repository layout

```
apps/api         Express 5 + TypeScript API, Socket.IO gateway and BullMQ worker (two entry points)
apps/web         React 19 + Vite + Tailwind CSS 4 single-page app
packages/shared  Zod schemas and types shared by API and web
deploy/          nginx configuration for the web image
docs/            Architecture and engineering documentation
Dockerfile       API/worker and web images (multi-stage, non-root)
.github/         CI/CD: lint, types, tests, build, images (published to GHCR from main)
```

## Prerequisites

- Node.js 22.12+ (`.nvmrc` pins 22)
- Docker Desktop (runs MongoDB and Redis)
- A free [Clerk](https://clerk.com) application (authentication)

## Getting started

```bash
npm install
cp apps/api/.env.example apps/api/.env          # then set CLERK_SECRET_KEY
cp apps/web/.env.example apps/web/.env.local    # then set VITE_CLERK_PUBLISHABLE_KEY
npm run dev             # databases, API, worker and web app together; Ctrl+C stops them
```

Then open http://localhost:5173. `npm run dev` starts MongoDB and Redis in Docker (Docker Desktop must be
running), then the API (port 4000), the background worker and the web app (port 5173), with each output
line labelled. To run a piece on its own: `npm run infra:up`, `npm run dev:api`, `npm run dev:worker`,
`npm run dev:web`. `npm run infra:down` stops the databases (data is kept).

Check the API: `curl http://localhost:4000/health/ready`

Tests need the Redis container running (`npm run infra:up`); MongoDB tests use an in-memory replica set.

### Running the production build locally (Docker)

```bash
npm run stack:up        # builds the images, starts MongoDB, Redis, API, worker and nginx
```

Then open http://localhost:8080. This is the same build CI produces: compiled JavaScript with
`NODE_ENV=production`, JSON logs, the web app served by nginx, which proxies `/api` and `/socket.io` to the
API. Settings come from `apps/api/.env` at run time (nothing secret is built into an image); the web
image takes the Clerk publishable key from `apps/web/.env.local`. `npm run stack:down` stops it (data is
kept); `docker compose --profile app logs -f api worker web` follows the logs.

### CI/CD

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request: dependency
audit, formatting, lint, type checks, all tests (with a Redis service) and the build, then builds both
Docker images. On `main` it publishes them to GitHub Container Registry, tagged with the commit SHA and
`latest`. Set the repository variable `VITE_CLERK_PUBLISHABLE_KEY` (public, not a secret) before the first
publish.

### Clerk setup

1. In the Clerk Dashboard, **Configure → API keys**: copy the publishable key into
   `apps/web/.env.local` and the secret key into `apps/api/.env`.
2. Optional, for networkless token verification: copy the **JWT public key (PEM)** into
   `CLERK_JWT_KEY` on one line, with `\n` for line breaks.
3. Optional, to sync profile changes and deletions: **Configure → Webhooks**, add an endpoint at
   `https://<public-api-url>/api/v1/webhooks/clerk` subscribed to `user.created`, `user.updated` and
   `user.deleted`, and set `CLERK_WEBHOOK_SIGNING_SECRET`. Locally this needs a tunnel (e.g. ngrok).
   Sign-in works without webhooks: users are provisioned on their first request.

### ImageKit setup (photos, videos, stories, avatars)

In the ImageKit dashboard, **Developer options → API keys**: copy the public key and the private key into
`IMAGEKIT_PUBLIC_KEY` and `IMAGEKIT_PRIVATE_KEY` in `apps/api/.env`. The private key stays on the server;
browsers only receive short-lived signed upload credentials. Without these keys the app runs, but uploads
and stories are disabled. Run the worker (`npm run dev:worker`) to clean up unused uploads hourly.

### Troubleshooting: Docker Desktop won't start on Windows

If Docker Desktop fails with `remove ...\dockerInference: The file cannot be accessed by the system`,
run `scripts\windows\start-docker.ps1` instead of launching Docker directly. Some Windows builds can't
delete stale unix-socket files; the script moves them aside and starts Docker.

## Scripts

| Command                                   | Purpose                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm test`                                | Run all test suites (MongoDB tests use an in-memory replica set)                                            |
| `npm run lint` / `npm run format`         | ESLint (type-aware) / Prettier                                                                              |
| `npm run typecheck`                       | Strict TypeScript across all workspaces                                                                     |
| `npm run build`                           | Build shared, API and web                                                                                   |
| `npm run seed -w @vibe/api`               | Seed realistic users, follows, posts, likes and comments (`-- --connect <your-username>` to join the graph) |
| `npm run db:sync-indexes -w @vibe/api`    | Build missing indexes and drop stale ones (production runs with `autoIndex` off)                            |
| `npm run db:backfill-search -w @vibe/api` | Fill user search keys for accounts created before search existed (idempotent)                               |
| `npm run stack:up` / `npm run stack:down` | Production build of the whole app in Docker, on http://localhost:8080                                       |
| `npm run load-test -w @vibe/api`          | HTTP load test of the production server build (needs `npm run build` and `npm run infra:up`)                |
| `npm run bench:feed -w @vibe/api`         | Feed read and fan-out costs as followings grow                                                              |

## Roadmap

1. Planning ✅
2. Foundation ✅
3. Authentication and user management ✅
4. Posts, comments, likes, follows ✅
5. Feed architecture, indexing, Redis caching ✅
6. Stories and media ✅
7. Real-time messaging and notifications ✅
8. Search and discovery ✅
9. Testing, performance and security review ✅
10. Docker, CI/CD, documentation ✅
