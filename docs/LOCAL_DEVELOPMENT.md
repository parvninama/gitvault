# Running GitVault Locally

This guide explains how to run GitVault using its Local Storage Backend and verify the complete storage workflow.

Local Mode simulates Git-like repositories on the local filesystem. It does not require a GitHub account, OAuth credentials, or an internet connection for storage operations.

> **Note:** Local Mode is a simulation of Git's versioning behaviour. It does not create actual Git repositories. It uses a commit log and a content-addressed object store to simulate Git-like storage.

---

## 1. Prerequisites

GitVault requires:

- Node.js >= 22.18
- npm
- A terminal
- A modern web browser

Check your installed versions:

```bash
node -v
npm -v
```

If Node.js is outdated, update it before proceeding.

---

## 2. Installation

Clone the repository and navigate into the project directory:

```bash
git clone <repository-url>
cd gitvault
```

Install the dependencies:

```bash
npm install
```

Create the environment configuration:

```bash
cp .env.example .env
```

Open `.env` and ensure the following configuration is present:

```env
STORAGE_BACKEND=local
DATABASE_PATH=./data/gitvault.sqlite
PORT=3001
```

GitHub credentials are not required in Local Mode.

### Important configuration variables

| Variable | Default | Description |
|---|---|---|
| `STORAGE_BACKEND` | `local` | Selects the storage backend. |
| `DATABASE_PATH` | `./data/gitvault.sqlite` | Location of the SQLite database. |
| `PORT` | `3001` | HTTP server port. |
| `TARGET_REPOSITORY_SIZE` | `1 GiB` | Target size for each repository. |
| `MAX_REPOSITORIES` | `3` | Maximum number of repositories. |
| `MAX_GITHUB_FILE_SIZE` | `90 MiB` | Maximum encoded file size. |

The local repository and restore directories are created alongside the configured SQLite database.

---

## 3. Build the Frontend

Build the React frontend using Vite:

```bash
npm run client:build
```

The generated frontend is placed in:

```text
dist/client/
```

If Vite is unavailable or the build fails because of a dependency issue, use the alternative esbuild command:

```bash
npm run client:build:esbuild
```

---

## 4. Start the Application

Run the development server:

```bash
npm run dev
```

The application should start at:

```text
http://127.0.0.1:3001
```

Open this address in your browser.

The application should display the GitVault dashboard and indicate:

```text
Local mode: repositories are simulated on disk.
No GitHub account needed.
```

If Express is unavailable, GitVault automatically falls back to its Node.js HTTP server. Both hosts use the same API routes.

### Optional: Frontend development with hot reload

For frontend development, run the following in two separate terminals.

Terminal 1:

```bash
npm run dev
```

Terminal 2:

```bash
npm run client:dev
```

Open:

```text
http://localhost:5173
```

Vite proxies API requests to the backend.

---

## 5. Local Storage Directory Structure

By default, GitVault uses the following directory structure:

```text
gitvault/
│
├── data/
│   ├── gitvault.sqlite
│   ├── gitvault.sqlite-shm
│   ├── gitvault.sqlite-wal
│   │
│   ├── local-repos/
│   │   └── mycloud-01/
│   │       ├── log.json
│   │       └── objects/
│   │
│   ├── restored/
│   │   └── uploads/
│   │
│   └── experiments/
│
├── src/
├── dist/
├── package.json
└── .env
```

### Directory responsibilities

| Path | Purpose |
|---|---|
| `data/gitvault.sqlite` | Stores file metadata and repository accounting. |
| `data/local-repos/` | Contains simulated repositories. |
| `data/local-repos/mycloud-01/log.json` | Stores the simulated commit history. |
| `data/local-repos/mycloud-01/objects/` | Stores file contents as content-addressed objects. |
| `data/restored/` | Stores locally restored original files. |
| `data/experiments/` | Contains isolated storage experiment data. |

The SQLite WAL and SHM files are SQLite-managed files. They should not be manually deleted while the application is running.

---

## 6. Inspecting Local Repositories

Navigate to the project root and inspect the repositories:

```bash
ls -lah data/local-repos/
```

Inspect a particular repository:

```bash
ls -lah data/local-repos/mycloud-01/
```

Display the simulated commit history:

```bash
cat data/local-repos/mycloud-01/log.json
```

For readable JSON output:

```bash
jq '.' data/local-repos/mycloud-01/log.json
```

List all stored objects:

```bash
find data/local-repos/mycloud-01/objects/ -type f
```

Inspect object sizes:

```bash
du -ah data/local-repos/mycloud-01/objects/
```

### Understanding the object store

Each object is identified by its SHA-256 hash.

For example:

```text
objects/
├── 36be3f84...
├── c0a8e212...
└── 15ee5a69...
```

These objects can represent:

- PARW files.
- Pointer files.
- Other content stored by the local backend.

The object store retains historical objects even when they are removed from the current repository tree.

---

# 7. Verifying the Storage Workflow

GitVault supports four main file operations:

1. Upload
2. Archive
3. Restore
4. Download

The following tests verify that each operation behaves as expected.

## 7.1 Upload Verification

### Step 1: Prepare a test file

Create a sample text file:

```bash
mkdir -p test-files

yes "GitVault compression test" | head -c 5000000 > test-files/test.txt
```

This creates a 5 MB text file.

Calculate its original SHA-256 hash:

```bash
shasum -a 256 test-files/test.txt
```

Record the hash.

### Step 2: Upload the file

1. Open GitVault.
2. Navigate to Upload.
3. Select `test.txt`.
4. Review the compression preview.
5. Upload the file.

### Step 3: Verify the upload

Navigate to Files.

Confirm that:

- The file appears in the file listing.
- Its status is Active.
- Its original size is displayed.
- Its stored PARW size is displayed.
- Compression information is available.

Inspect the local repository:

```bash
find data/local-repos/ -type f
```

You should find a corresponding `.parw` object referenced by the repository's commit log.

### Expected result

The uploaded file should be stored in PARW format, and its metadata should be recorded in SQLite.

---

## 7.2 Archive Verification

### Step 1: Record the current commit history

Before archiving, inspect:

```bash
jq '.' data/local-repos/mycloud-01/log.json
```

Identify the latest commit.

### Step 2: Archive the file

1. Navigate to Files.
2. Find the uploaded file.
3. Click Archive.
4. Confirm the operation.

### Step 3: Verify the archive operation

Inspect the commit history again:

```bash
jq '.' data/local-repos/mycloud-01/log.json
```

A new commit should appear with an archive message.

Its changes should include:

- Removal of the original `.parw` path.
- Addition of the `.parw.pointer` path.

Inspect the current file listing in GitVault.

The file should now have Archived status.

### Step 4: Verify historical object retention

Inspect the objects directory:

```bash
du -ah data/local-repos/mycloud-01/objects/
```

The original PARW object should still exist.

The pointer should also have its own stored object.

### Expected result

The original PARW file should no longer exist in the current repository tree, but its historical object should remain available.

Archiving does not reclaim the historical storage occupied by the original object.

---

## 7.3 Restore Verification

GitVault supports two restore modes.

### A. Local Restore

This retrieves the original file from Git history and writes it to the local restore directory.

Steps:

1. Navigate to Archived.
2. Select the archived file.
3. Click Restore.
4. Leave the option to restore to the repository tree disabled.
5. Start the restore operation.

GitVault should execute its verification steps:

1. Read pointer.
2. Locate original commit.
3. Fetch historical file.
4. Verify PARW SHA-256.
5. Decode PARW.
6. Verify original SHA-256.
7. Write original file locally.

### Verify the restored file

Inspect the restore directory:

```bash
find data/restored/ -type f -print
```

For the example file:

```bash
ls -lah data/restored/uploads/
```

Calculate its hash:

```bash
shasum -a 256 data/restored/uploads/test.txt
```

Compare it with the original hash recorded during upload.

The hashes should match exactly.

The file should remain marked as Archived because it has not been restored to the repository tree.

### B. Restore to Repository Tree

Now test the second restore mode.

1. Navigate to Archived.
2. Select the file.
3. Click Restore.
4. Enable the option to put the file back into the repository tree.
5. Start the restore operation.

### Verify the result

Inspect the commit history:

```bash
jq '.' data/local-repos/mycloud-01/log.json
```

A new restore commit should appear.

Its changes should include:

- Removal of the pointer file.
- Addition of the original PARW file.

Navigate to Files.

The file should now have Active status.

### Expected result

The original file should be recovered locally, and the optional repository restore should make the PARW file active in the current repository tree again.

---

## 7.4 Download Verification

Download tests the retrieval of an active file directly from the current repository tree.

### Step 1: Download the file

1. Navigate to Files.
2. Find an active file.
3. Click Download.

The browser should download the original file.

### Step 2: Verify file integrity

Calculate the SHA-256 hash of the downloaded file:

```bash
shasum -a 256 /path/to/downloaded/test.txt
```

Compare it with the original file's hash.

Both hashes should match.

### Expected result

The downloaded file should be byte-for-byte identical to the original file.

Download should retrieve the active PARW file, decode it, verify its integrity, and return the original bytes.

---

# 8. Automated Testing

GitVault includes automated tests for its storage logic, API, and browser workflow.

### Unit and integration tests

Run:

```bash
npm test
```

These tests cover components such as:

- PARW encoding and decoding.
- Pointer creation and validation.
- StorageService operations.
- Repository allocation.
- Local storage backend.
- API routes and HTTP workflows.

### Type checking

Run:

```bash
npm run typecheck
```

This checks TypeScript types.

### Browser end-to-end testing

Install Chromium for Playwright:

```bash
npx playwright install chromium
```

Build the frontend:

```bash
npm run client:build
```

Run:

```bash
npm run e2e
```

The E2E script starts a separate server and uses temporary directories for its test database and repositories.

It tests:

- Dashboard loading.
- File upload.
- Compression preview.
- File listing.
- Download integrity.
- Archive operation.
- Restore with progress reporting.
- Restore integrity.
- Restore failure handling.
- Storage experiment.
- Repository and settings pages.

The E2E tests do not use your normal `data/` directory.

---

# 9. Verification Checklist

Use this checklist when testing a new local installation.

| Test | Expected result | Verified |
|---|---|---|
| Application startup | Dashboard opens in Local Mode | [ ] |
| Upload | PARW file is stored | [ ] |
| Metadata | File information is recorded in SQLite | [ ] |
| Compression | PARW size and compression ratio are displayed | [ ] |
| Archive | Pointer replaces PARW file in current tree | [ ] |
| Historical retention | Original object remains stored | [ ] |
| Local restore | Original file is written to restore directory | [ ] |
| PARW integrity | Encoded file hash is verified | [ ] |
| Original integrity | Decoded file hash matches original | [ ] |
| Restore to tree | Pointer is replaced by PARW file | [ ] |
| Download | Original file is returned | [ ] |
| Automated tests | Unit and integration tests pass | [ ] |
| Browser tests | E2E workflow passes | [ ] |

---

# 10. Important Notes and Limitations

1. Local Mode is a Git-like simulation, not a real Git repository.
2. The local backend stores historical objects and does not automatically garbage-collect them.
3. Archiving removes a file from the current tree but does not reclaim its historical storage.
4. SQLite stores metadata, not the actual media files.
5. PARW compression may make already-compressed files slightly larger because of container overhead.
6. Chunked upload primitives exist, but chunked uploads are not integrated into the application workflow.
7. The local storage experiment uses an isolated simulation and does not modify the user's actual storage volume.
8. Local Mode verifies application logic and integrity checks, but does not prove how GitHub's actual server-side storage behaves.
9. GitHub backend testing against the real GitHub API is a separate experiment.

**GitVault is an experimental research prototype. It should not be treated as an unlimited storage service or a production backup solution.**z