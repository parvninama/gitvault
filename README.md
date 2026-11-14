<div align="center">

# GitVault

**Versioned, content-addressed file storage backed by Git.**

![Node](https://img.shields.io/badge/node-%3E%3D22.18-8B0000)
![TypeScript](https://img.shields.io/badge/TypeScript-8B0000)
![Status](https://img.shields.io/badge/status-proof%20of%20concept-8B0000)
![License](https://img.shields.io/badge/license-see%20LICENSE-8B0000)

</div>

GitVault explores how Git repositories can act as a storage backend behind a single virtual filesystem. Files are packaged into a custom `.parw` container, verified with SHA-256, and spread across one or more repositories. You can upload, download, archive, and restore files while keeping their history.

> **Proof of concept.** GitVault is not an unlimited storage service or a production backup solution. GitHub's limits, policies, and API constraints still apply.

## Why GitVault?

Git already gives you content addressing, history, and integrity checks. GitVault asks what a file store looks like if you build directly on those properties instead of bolting versioning onto a blob store.

| | Git LFS | S3 | IPFS | GitVault |
|---|---|---|---|---|
| Built on Git history | Pointer files | No | No | Yes |
| Integrity checks | Yes | Optional | Yes | SHA-256 on container and original |
| Multi-repo virtual filesystem | No | N/A | N/A | Yes |
| Production-ready | Yes | Yes | Yes | **No** |

## Features

- **Virtual filesystem** across multiple repositories
- **`.parw` container** with Zstandard compression when it helps
- **Two-level integrity checks**: container checksum and original-file checksum
- **Archive and restore** using lightweight pointer files
- **Fill-first allocation** across repositories, based on historical size estimates
- **GitHub OAuth** with real private repositories as backends
- **Local mode** for development without a GitHub account
- **Storage experiment** comparing current tree size against retained history

## Quick start

Requires Node.js 22.18+ (for `node:sqlite`, Zstandard, and TypeScript type stripping), npm, and Git.

```bash
git clone https://github.com/parvninama/gitvault.git
cd gitvault
npm install
cp .env.example .env
npm run dev
```

Open <http://127.0.0.1:3001>. Local mode is the default and needs no GitHub account.

**Try it:**

1. Upload a file from the UI.
2. Archive it. The active `.parw` is replaced by a `.parw.pointer`.
3. Restore it from Git history and confirm the checksum passes.

Or from the command line:

```bash
curl -X POST --data-binary @report.pdf \
  "http://127.0.0.1:3001/api/files?path=documents/report.pdf"
```

The body is the raw file bytes, not multipart form data.

```
documents/report.pdf.parw            # active
documents/report.pdf.parw.pointer    # after archiving
```

## How it works

```
Browser -> React frontend -> API client -> HTTP server -> API routes
                                                             |
                                                       StorageService
                                                      /              \
                                              MetadataStore     RepositoryManager
                                                (SQLite)               |
                                                                 StorageProvider
                                                                /               \
                                                  LocalStorageProvider   GitHubStorageProvider
                                                         |                       |
                                                    Local disk            GitHub REST API
```

Local and GitHub providers share the same versioned-storage workflow, so storage logic stays independent of the backend.

**Upload:** validate path, hash, encode to `.parw`, allocate a repository, commit, record metadata.
**Download:** fetch container, verify container checksum, decode, verify original checksum.
**Archive:** swap the active `.parw` for a pointer. The original stays reachable in Git history.
**Restore:** follow the pointer to the historical commit, verify both checksums, write the file back.

> Archiving shrinks the current tree, **not** the repository's total storage. Old objects remain in Git history.

## Status

| Working and tested | Not yet |
|---|---|
| PARW encode/decode, SHA-256 verification | Chunked uploads (primitives exist, not integrated) |
| Archive and restore | Persistent GitHub token storage |
| Local and multi-repo management | Production-scale reliability and security review |
| GitHub OAuth, repo creation, upload, download, archive, restore (verified against the real API) | |
| Metadata persistence across restarts | |

Full verification steps: [docs/verification.md](docs/verification.md)

## GitHub mode

Set these in `.env`:

```env
STORAGE_BACKEND=github
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
GITHUB_CALLBACK_URL=http://127.0.0.1:3001/api/auth/github/callback
DATABASE_PATH=./data/gitvault-github.sqlite
```

Create an OAuth App under **GitHub Settings -> Developer settings -> OAuth Apps** with homepage `http://localhost:3001` and the callback URL above, then restart the backend and connect your account.

- Use `127.0.0.1` or `localhost` consistently. Mixing them breaks OAuth state and cookies.
- The classic OAuth `repo` scope is broad. A scoped GitHub App would be safer.
- Repositories are created as private: `mycloud-01`, `mycloud-02`, and so on, up to `MAX_REPOSITORIES`.
- The OAuth token lives in server memory, so you reconnect after a restart. Metadata persists in SQLite.
- Use a dedicated test account. Committed files can remain in Git history after archiving.
- Check [GitHub's Terms of Service and acceptable use policies](https://docs.github.com/en/site-policy) before using repositories as general file storage.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `STORAGE_BACKEND` | `local` | `local` or `github` |
| `DATABASE_PATH` | `./data/gitvault.sqlite` | SQLite location |
| `TARGET_REPOSITORY_SIZE` | 1 GiB | Target size for repository allocation |
| `MAX_REPOSITORIES` | 3 | Maximum repositories to create |
| `MAX_GITHUB_FILE_SIZE` | 90 MiB | Max encoded file size for GitHub |
| `PORT` | 3001 | Backend port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Allowed origin for state-changing requests |

GitHub OAuth variables are listed in [GitHub mode](#github-mode).

## Development

```bash
npm run dev           # backend
npm run client:dev    # frontend with hot reload (http://localhost:5173)
npm test              # unit and integration tests
npm run e2e           # browser tests (needs Playwright + Chromium)
npm run client:build  # build the frontend
npm run experiment    # storage experiment
npm run parw:encode -- file
npm run parw:decode -- file.parw
```

## Known limitations

- Uploads are buffered in memory and capped by configured size limits.
- Simultaneous GitHub operations can hit non-fast-forward conflicts.
- GitHub does not expose exact historical storage, so usage figures are estimates.
- GitHub API rate limits apply, and each upload takes several requests.
- Previews and uploads are separate operations, so a file may be processed twice.

## Roadmap

- [ ] Integrate chunked uploads for large files
- [ ] Persist GitHub tokens securely
- [ ] Support a scoped GitHub App instead of a classic OAuth App
- [ ] Handle concurrent commits safely

## Documentation

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Storage workflows](docs/STORAGE_FILES.md)
- [PARW container format](docs/PARW_FORMAT.md)
- [API reference](docs/API.md)
- [Storage experiment](docs/STORAGE_EXPERIMENT.md)
- [GitHub verification](docs/VERIFICATION.md)
- [Local development](docs/LOCAL_DEVELOPMENT.md)

## Design principles

- **Backend independence:** workflows don't depend on a specific provider.
- **Integrity first:** every restored file must pass checksum verification.
- **Explicit limitations:** estimates are never presented as exact measurements.
- **History awareness:** current tree size and historical storage are different things.
- **Controlled allocation:** repository creation respects capacity and count limits.

## Contributing

Issues and pull requests are welcome. Please open an issue first for larger changes.

## License

See [LICENSE](LICENSE). <!-- Name it here, e.g. "MIT. See LICENSE." -->