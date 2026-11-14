# Verification

This page records what has been tested, and what has not.

## Component status

| Component | Status |
|---|---|
| PARW encoding and decoding | Implemented and tested |
| SHA-256 integrity verification | Implemented and tested |
| Archive and restore workflows | Implemented and tested |
| Local storage backend | Verified |
| Multi-repository management | Implemented and tested |
| React frontend | Implemented |
| GitHub OAuth authentication | Verified against GitHub |
| GitHub repository creation | Verified |
| GitHub upload and download | Verified, including checksum comparison |
| GitHub archive and restore | Verified against a real repository |
| Metadata persistence | Verified across backend restart and reconnection |
| Chunked uploads | Not integrated |
| Persistent GitHub token storage | Not implemented |
| Production-scale reliability and security | Not evaluated |

## GitHub integration check

The GitHub backend was exercised against the real GitHub API, not a mock:

1. Authenticate through GitHub OAuth.
2. Create a private repository.
3. Upload a file.
4. Download the file and compare its SHA-256 checksum with the original.
5. Archive the file, replacing it with a pointer.
6. Restore the file to the repository.
7. Restart the backend, reconnect GitHub, and confirm repository metadata persisted.

## What this does and does not show

These tests show that the primary workflow works with a real GitHub repository. They do **not** establish production readiness: concurrency, security, reliability, and scalability have not been evaluated sufficiently.