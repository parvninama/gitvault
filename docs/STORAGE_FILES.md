# Storage Flows

This document describes how GitVault handles the four main file operations: Upload, Archive, Restore, and Download.

## 1. Upload

When a user uploads a file, GitVault encodes it into the PARW format and stores it in an allocated repository.

### Execution Flow

1. The user selects a file through the React frontend.
2. Upload.tsx calls uploadFile() from src/client/api/client.ts.
3. The API client sends an HTTP POST request to /api/files with the raw binary file as the request body.
4. src/server/api/routes.ts receives the request, checks whether the virtual path is provided, and passes the file data to StorageService.
5. StorageService.upload() performs the following operations:
    * Normalizes the virtual path.
    * Checks whether the file already exists.
    * Calculates the original file’s SHA-256 hash.
    * Encodes the file into PARW format.
    * Checks whether the encoded file exceeds the configured size limit.
6. StorageService calls RepositoryManager.allocate() to select a suitable repository.
7. RepositoryManager returns the selected repository and its StorageProvider.
8. StorageService calls StorageProvider.uploadFile() to store the encoded file.
9. The storage provider commits the PARW file to the selected backend.
10. RepositoryManager updates its repository usage estimates.
11. StorageService saves the file metadata in SQLite through MetadataStore.
12. The upload result is returned to the frontend.

### Important Details

* The original file is hashed before PARW encoding.
* PARW uses Zstandard compression when beneficial and raw storage when compression does not help.
* The repository is selected based on its estimated capacity.
* SQLite stores metadata such as file path, repository ID, file sizes, hashes, and upload commit SHA.
* The Git commit and SQLite metadata insertion are separate operations, not one atomic transaction.

## 2. Archive

Archiving replaces the original PARW file in the current repository tree with a small pointer file.

The original file remains available in Git history.

### Execution Flow

1. The user requests to archive a file.
2. The frontend sends an archive request to the backend.
3. routes.ts forwards the request to StorageService.archive().
4. StorageService retrieves the file metadata from SQLite.
5. StorageService identifies the appropriate StorageProvider.
6. VersionedStorageProvider.archiveFile() retrieves the original PARW file.
7. It obtains the current HEAD commit SHA before creating the archive commit.
8. A pointer is created containing:
    * Original virtual file path.
    * Previous commit SHA.
    * PARW file SHA-256 hash.
    * PARW file size.
9. The provider creates a new Git commit that:
    * Deletes the original PARW file from the current tree.
    * Adds the pointer file in its place.
10. StorageService updates the file’s SQLite metadata to mark it as archived.
11. RepositoryManager updates its repository usage estimates.
12. The result is returned to the frontend.

### Important Details

* The pointer contains the commit SHA needed to locate the original PARW file during restoration.
* Deletion of the PARW file and creation of the pointer happen in the same Git commit.
* The original Git object remains in Git history.
* Archiving reduces the current repository tree footprint but does not reclaim the historical storage occupied by the original file.

## 3. Restore

Restoring retrieves an archived file from Git history, verifies its integrity, decodes it, and writes the original file to the local restore directory.

GitVault also supports optionally restoring the PARW file to the current repository tree.

### Execution Flow

1. The user requests to restore an archived file.
2. The frontend sends a restore request to the backend.
3. routes.ts forwards the request to StorageService.restore().
4. StorageService retrieves the file metadata from SQLite and checks its status.
5. StorageService identifies the appropriate StorageProvider.
6. VersionedStorageProvider.restoreFile() begins the recovery process.
7. The pointer file is retrieved and validated.
8. The commit SHA stored in the pointer is used to locate the original PARW file in Git history.
9. The original PARW file is retrieved from the historical commit.
10. The PARW file’s SHA-256 hash is verified against the pointer.
11. The PARW file is decoded to recover the original file.
12. The original file’s SHA-256 hash is verified.
13. The recovered file is written to the configured local restore directory.
14. If repository restoration was requested:
    * The pointer is removed from the current repository tree.
    * The original PARW file is added back.
    * A new Git commit is created.
15. SQLite metadata and repository accounting are updated as appropriate.
16. The restore result is returned to the frontend.

### Two Restore Modes

#### Local Restore

* Retrieves the original PARW file from Git history.
* Verifies and decodes it.
* Writes the original file to the local restore directory.
* Leaves the pointer in the repository.
* The file remains marked as archived.

#### Restore to Repository Tree

* Performs the same retrieval and verification steps.
* Removes the pointer from the current repository tree.
* Adds the original PARW file back.
* Creates a new Git commit.
* Updates the file status to active.

### Important Details

* Restore uses the commit SHA stored in the pointer to locate the original file.
* Both the PARW hash and original file hash are verified.
* If a verification step fails, the recovery process stops.
* The restore API streams progress information to the frontend using newline-delimited JSON (NDJSON).

## 4. Download

Downloading retrieves an active PARW file from the current repository tree, decodes it, and returns the original file to the user.

Unlike restore, download does not need to retrieve the file from Git history.

### Execution Flow

1. The user requests to download an active file.
2. The frontend requests the download endpoint.
3. routes.ts forwards the request to StorageService.
4. StorageService retrieves the file metadata from SQLite.
5. It checks that the file is active.
6. StorageService identifies the appropriate StorageProvider.
7. The provider retrieves the PARW file from the current repository tree.
8. The PARW file’s SHA-256 hash is verified against the stored metadata.
9. The PARW file is decoded to recover the original file.
10. The original file’s SHA-256 hash is verified.
11. The original file bytes are returned to the API layer.
12. The server responds with the appropriate MIME type and filename.
13. The browser downloads the original file.

### Important Details

* Download is intended for active files.
* Archived files must be restored before they can be downloaded through this workflow.
* The PARW file is retrieved from the current repository tree rather than a historical commit.
* Both hashes are verified before returning the original file.
* Unlike local restore, download does not write a separate copy into the server’s restore directory.

⸻

## 5. Summary

Operation	Source of file data	Result
Upload	User’s local file	PARW file stored in repository
Archive	Current repository tree	Pointer replaces PARW file
Restore	Historical Git commit	Original file recovered locally
Download	Current repository tree	Original file returned to user