# GitVault POC: an experiment in Git-backed storage

**This is an experimental research prototype.** It asks one question: *is a Git-backed virtual storage system technically viable?*
It does **not** claim unlimited or free GitHub storage, and it is not a production backup system.

> **Archiving removes a file from the current tree but does not necessarily remove the historical Git object.**
> Replacing a file with a pointer shrinks the *current tree* only. The original blob stays in Git history,
> so repository size does not drop. Measuring exactly that is the point of the Storage Experiment page.

## What it does
Upload files, compress/package them into a custom `.parw` container (zstd + SHA-256), store them in one or more Git repositories
presented as a single virtual filesystem, "archive" a file (replace it with a tiny pointer, keeping the original reachable in history),
and "restore" it with every checksum verified.

## Status: what has and has not been verified
| Area | State |
|---|---|
| PARW codec, pointers, chunking primitives, multi-repo manager, StorageService | Unit/integration tested |
| Local mode, whole workflow through the **real server and a real Chromium browser** | Verified (`npm run e2e`) |
| React UI (7 pages) | Verified in the browser E2E, built with esbuild |
| Express host (`src/server/api/app.ts`) | **Written, never run.** Express and Vite could not be installed where this was built. All behaviour lives in a framework-neutral route table (`routes.ts`) that *is* tested via a `node:http` host; Express is a ~20-line adapter. |
| Vite (`vite.config.ts`, `npm run client:dev/build`) | **Not run** (same reason). The bundle used for testing was built with esbuild (`npm run client:build:esbuild`). |
| `GitHubStorageProvider` | Tested against an in-memory **fake** GitHub only. **Never run against the real API.** |
| Type-checking (`npm run typecheck`) | **Not run** (`@types/*` unavailable). Code runs via Node's type stripping. |
| Chunked upload | Primitives tested; **not integrated** (deliberately deferred until the GitHub experiment says it is worthwhile). |

## Architecture
```
 Browser (React)                    src/client/pages, components      <- UI only. No storage logic, no GitHub.
    |  typed functions                src/client/api/client.ts        <- the ONLY place that calls fetch()
    v
 HTTP host: Express (app.ts) or node:http (httpServer.ts)             <- thin: read body, write response
    |
    v
 Route table + dispatcher           src/server/api/routes.ts          <- CSRF check, auth gate, error mapping
    |
    v
 StorageService                     src/server/storage/StorageService.ts
    |   encode PARW, verify, SQLite bookkeeping, one logical volume
    +--> MetadataStore (SQLite)     src/server/database
    +--> RepositoryManager          src/server/repository             <- picks a repo; capacity judged by HISTORICAL size
              |
              v
          StorageProvider interface src/server/storage/types.ts
              |
              +--> LocalStorageProvider   (git-like simulation on disk; default)
              +--> GitHubStorageProvider  (REST/Git Data API; EXPERIMENTAL, isolated in src/server/github)
```
Archive/restore/upload logic is written once in `VersionedStorageProvider` over a tiny `VersionedBackend`
(`commit`, `getFile(path, ref)`, `listTree`, `stats`), so the local simulation and GitHub exercise the same workflow code.

## Local setup (no GitHub account needed)
Requires **Node >= 22.18** (built-in zstd, `node:sqlite`, TypeScript type stripping).
```
npm install
npm run client:build        # Vite build -> dist/client   (fallback without Vite: npm run client:build:esbuild)
npm run dev                 # http://127.0.0.1:3001  (serves the UI and the API)
```
UI development with hot reload: `npm run dev` in one terminal, `npm run client:dev` in another (http://localhost:5173, proxies /api).
If `express` is not installed the server logs that it fell back to the `node:http` host; routes are identical.

Tests: `npm test` (server + client API + HTTP workflow). Browser E2E: `npm run e2e` (needs Playwright + Chromium and a client build).
CLI: `npm run experiment`, `npm run parw:encode -- file`, `npm run parw:decode -- file.parw`.

## Environment variables (`.env.example`)
| Variable | Default | Meaning |
|---|---|---|
| `STORAGE_BACKEND` | `local` | `local` or `github` (experimental) |
| `DATABASE_PATH` | `./data/gitvault.sqlite` | SQLite file; `local-repos/`, `restored/`, `experiments/` live beside it |
| `TARGET_REPOSITORY_SIZE` | 1 GiB | per-repository target, compared against *historical* size |
| `MAX_REPOSITORIES` | 3 | hard cap; the app never creates unlimited repos |
| `MAX_GITHUB_FILE_SIZE` | 90 MiB | encoded files above this are refused (not uploaded); do not rely on 100 MB |
| `GITHUB_CLIENT_ID/SECRET`, `GITHUB_CALLBACK_URL` | empty | OAuth app (github mode only) |
| `PORT`, `CLIENT_ORIGIN` | 3001, `http://localhost:5173` | server port; origin allowed for state-changing requests in dev |

## Local mode
Repositories are directories with a git-like commit log and a content-addressed object store; old objects are never deleted,
mirroring Git's behaviour. In local mode the Storage Experiment runs in an isolated throwaway simulation, never touching your files.
Restore has an optional "slow motion" switch (local only) so the live step display is observable.

## GitHub mode (experimental)
`STORAGE_BACKEND=github`. The UI shows "Experimental GitHub backend" everywhere it matters. Use a **throwaway account/repositories**:
every blob pushed stays in Git history permanently, and the experiment endpoint requires an explicit confirmation flag.
Repositories are created private as `mycloud-01`, `mycloud-02`, ... under the authenticated user, up to `MAX_REPOSITORIES`.

### OAuth setup
1. GitHub > Settings > Developer settings > OAuth Apps > New OAuth App.
2. Homepage `http://localhost:3001`; callback URL `http://127.0.0.1:3001/api/auth/github/callback`.
3. Put the client id/secret and the callback URL in `.env`. The secret and the access token never leave the server process
   (the token is held in memory; the browser only sees `connected: true`).
4. **Permissions:** a classic OAuth App's narrowest scope covering private repos and repo creation is `repo` (broad: full control of your
   repositories). `public_repo` suffices only for public repositories. A GitHub App with *Contents: read & write*
   (+ *Administration: write* only if the app should create repositories) is narrower and preferable. Device flow helpers exist in `github/auth.ts` but are not exposed in the UI.

## API overview
| Method & path | Purpose |
|---|---|
| `GET /api/auth/status`, `GET /api/settings` | backend, connection, limits (no secrets) |
| `GET /api/files[?status=]`, `GET /api/tree` | files / virtual folder tree |
| `POST /api/files?path=a/b.jpg` | **raw-body** upload (body = file bytes, no multipart) |
| `POST /api/files/preview?path=` | dry run: PARW size, ratio, target repository; writes nothing |
| `GET /api/files/download?path=` | decoded, checksum-verified original (active files) |
| `POST /api/files/archive` `{path}` | replace with pointer (one commit) |
| `POST /api/files/restore` `{path, restoreToTree?, slowMs?}` | streams NDJSON step events (`start`, `step`, `done`/`error`) |
| `GET /api/experiment/dashboard`, `GET /api/repositories` | current tree vs historical vs estimate |
| `POST /api/experiment/run` `{sizesMiB, kind, confirmGitHub?}` | history experiment (<= 4 files, <= 50 MiB each) |
| `GET /api/auth/github/login|callback`, `POST /api/auth/device/*`, `POST /api/auth/logout` | GitHub connection |

## PARW format (v1)
`"PARW"` | version u16 | metadata length u32 | metadata JSON | payload (all integers big-endian).
Metadata: `filename, extension, mimeType, originalSize, compression ("zstd" | "none"), sha256 (of the ORIGINAL bytes), compressedSize`.
zstd level 3; if zstd output is not smaller the payload is stored raw (so tiny/already-compressed files can be slightly *larger* than the original, and the UI says so).
Decoding verifies magic, version, lengths, decompressed size (bounded to defeat decompression bombs) and SHA-256; any mismatch throws a typed error.

## Archive / restore design
* **Path convention:** `<virtual path>.parw` (active) and `<virtual path>.parw.pointer` (archived). The original extension is kept in the name.
* **Archive:** read HEAD commit and the PARW file, build a pointer `{format, version, originalPath, commitSha, sha256, size}`, then in **one commit** delete the PARW file and add the pointer. The old blob remains reachable through `commitSha`. Nothing is freed.
* **Restore (8 steps, aborting at the first failure):** read pointer, locate commit, fetch historical object, verify PARW SHA-256, decode, verify original SHA-256 (also against the database record), write local file, optionally commit the PARW back into the tree (Git de-duplicates the identical blob).
* Pointers are validated strictly (no path traversal; `originalPath` must be a normalised `.parw` path).

## Multi-repository design
`RepositoryManager` fill-first allocates uploads across repositories and creates the next one only when needed and under `MAX_REPOSITORIES`.
**Capacity is judged by historical size**, because history never shrinks: after archiving, the current tree is tiny but the repository is as full as before
(covered by a test). The Files page presents one tree; repository and checksums appear only in a file's details and on the Repositories page.

## Known GitHub limitations (verify against current GitHub docs; these change)
* Hard per-file limit around 100 MB (warnings earlier); this project targets 90 MB and refuses larger files until chunking is integrated.
* GitHub recommends keeping repositories small (on the order of 1 GB, strongly discouraged beyond ~5 GB) and may contact owners of oversized ones.
* REST API rate limits apply; each upload is several API calls (blob, tree, commit, ref). Large blobs are sent base64-encoded (about 4/3 size).
* The REST API exposes only a rounded, possibly lagging repository `size` (KB). It does **not** expose history/object sizes, so the app reports those as *inferred* or `n/a`, never as measured.
* Terms of Service and acceptable-use policies for using a code host as bulk storage are **not evaluated** here; check them yourself.
* Removing data from Git history requires rewriting history and is outside this project.

## Storage experiment methodology
For each requested size (<= 50 MiB, default 1 and 5 MiB; random or compressible payload) the runner: generates the file, encodes PARW, uploads, snapshots usage,
archives (pointer replaces file), snapshots, restores from history and verifies SHA-256, restores into the tree, snapshots again.
Reported: **A** current tree bytes, **B** estimated repository size, **C** retained historical bytes, **D** commits, **E** binary objects ("n/a" when the backend cannot say),
plus timings and an automatically derived finding (did the repository footprint drop after archiving?).
**Interpretation:** a local-mode run only validates logic and checksums. The question that matters, how GitHub's server-side size
behaves after archiving, is answered only by running against a real throwaway repository (planned next step):
`GITHUB_TOKEN=... npm run experiment -- --provider github --repo you/throwaway --sizes 1,5`.

## Known limitations
No chunked upload integration; single-user, in-memory GitHub token; no user auth beyond a localhost origin check; uploads are buffered in memory (100 MB cap);
previews send each file twice; experiment/test files in a GitHub repo stay in its history; Express host and Vite config untested; GitHub backend untested against the real API.
