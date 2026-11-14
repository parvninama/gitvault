# Architecture

## 1. Project Overview

GitVault is a file storage system that uses GitHub repositories as its storage backend.

When a user uploads a file, GitVault packages it into a .parw file, stores it through the configured storage provider (Local or GitHub), and maintains the associated metadata in SQLite.

Archived files are represented by pointers in the current repository tree, while their original data remains retrievable through Git history.

The system supports multiple repositories that are managed as a single logical storage volume.

## 2. High-Level Architecture

                         USER
                           |
                           ▼
                    React Frontend
                           |
                           ▼
                       API Client
                           |
                           ▼
                       API Routes
                           |
                           ▼
                     StorageService
                    /       |       \
                   /        |        \
                  ▼         ▼         ▼
             Metadata  Repository   PARW
              Store     Manager    Codec
                           |
                           ▼
                    StorageProvider
                      /         \
                     /           \
                    ▼             ▼
             Local Provider   GitHub Provider
                    |             |
                    ▼             ▼
              Local Backend  GitHub Backend
                    |             |
                    ▼             ▼
                Local Disk   GitHub Repositories

## 3. Responsibilities of Each Layer

### 3.1 Frontend Layer

The frontend is built using React.

When a user selects a file and clicks upload, the frontend sends an HTTP POST request to the server.

The API client logic is located in:

src/client/api/client.ts

The frontend uses reusable API functions such as uploadFile() instead of implementing HTTP requests inside individual components.

The file is sent as a raw binary HTTP request body rather than JSON or multipart form data.

The frontend is responsible for:

* File selection.
* Displaying upload progress.
* Showing upload errors and results.
* Communicating with the backend through the API client.

### 3.2 API Layer

The API request handlers are located in:

src/server/api/routes.ts

Authentication is required for the file upload endpoint.

The API route:

1. Receives the HTTP POST request.
2. Extracts the virtual file path from the query parameter.
3. Checks whether the required path parameter exists.
4. Passes the virtual path, raw file data, and MIME type to StorageService.

If the path parameter is missing, the server returns HTTP 400.

Further path validation and normalization are handled by StorageService.

The API layer does not encode files into PARW format, calculate SHA-256 hashes, allocate repositories, or communicate directly with GitHub. These responsibilities belong to other components.

### 3.3 Storage Layer

The main application-level storage logic is implemented in:

src/server/storage/StorageService.ts

StorageService coordinates the entire file storage workflow.

It is responsible for:

* Validating and normalizing file paths.
* Checking for duplicate files.
* Calculating SHA-256 hashes.
* Encoding files into PARW format.
* Checking file size limits.
* Requesting repository allocation.
* Calling the appropriate StorageProvider.
* Updating repository usage and SQLite metadata.

Upload Workflow

The upload process follows this sequence:

                 upload()
                     |
                     ▼
              Normalize path
                     |
                     ▼
            Check duplicate file
                     |
                     ▼
              Calculate SHA-256
                     |
                     ▼
                Encode PARW
                     |
                     ▼
              Check file size
                     |
                     ▼
         RepositoryManager.allocate()
                     |
                     ▼
          StorageProvider.uploadFile()
                     |
                     ▼
           Update repository usage
                     |
                     ▼
              Save in SQLite
                     |
                     ▼
                Return result

### 3.4 StorageProvider

The StorageProvider interface is defined in:

src/server/storage/types.ts

It defines the common operations that a storage implementation must support, such as:

* Listing files.
* Uploading files.
* Downloading files.
* Archiving files.
* Restoring files.
* Checking storage usage.

GitVault currently supports two implementations:

LocalStorageProvider

* Used for local storage and simulation.
* Stores files on the local filesystem.

GitHubStorageProvider

* Used for GitHub-based storage.
* Communicates with GitHub through the GitHub backend.
* Uses GitHub repositories to store files.

Both providers follow the same StorageProvider interface.

This abstraction allows GitVault to support additional storage backends in the future without rewriting the entire application-level storage workflow.

### 3.5 RepositoryManager

Implemented in:

src/server/repository/RepositoryManager.ts

RepositoryManager manages multiple repositories as a single logical storage volume.

Its responsibilities include:

* Selecting an existing repository with sufficient capacity.
* Creating a new repository when existing repositories cannot accommodate an upload.
* Tracking estimated repository usage.
* Maintaining current and historical storage size estimates.
* Providing the appropriate StorageProvider for a repository.

For example, if mycloud-02 reaches its capacity, RepositoryManager can allocate a new repository such as mycloud-03.

It does not perform the actual file upload. Instead, it provides StorageService with the appropriate provider.

### 3.6 Metadata Store

Implemented in:

src/server/database/MetadataStore.ts

GitVault uses SQLite to maintain application metadata.

It stores information such as:

* Repository details.
* Virtual file paths.
* File names and MIME types.
* Original file sizes.
* PARW file sizes.
* Original and PARW SHA-256 hashes.
* Upload and archive commit information.
* File status.

SQLite stores metadata and repository accounting information, not the actual media files.

The actual file data is stored through the selected storage backend.

## 4. Application Startup

The application startup and dependency initialization are handled in:

src/server/index.ts

This file acts as the composition root of the application.

It creates and connects the different components required to run GitVault.

The startup process includes:

1. Loading application configuration.
2. Initializing SQLite and the metadata store.
3. Initializing the token store.
4. Selecting the storage backend based on configuration.
5. Creating the appropriate ProviderFactory.
6. Initializing RepositoryManager.
7. Creating StorageService with its required dependencies.
8. Setting up API dependencies and routes.
9. Starting the HTTP server.

GitVault can use either the local backend or GitHub backend depending on the configured storage backend.

Express is used when available, with a Node.js HTTP fallback.

## 5. Design Decisions

### 5.1 Separation of Responsibilities

The application separates frontend communication, API handling, storage orchestration, repository management, and backend operations.

This makes individual components easier to maintain and test.

### 5.2 StorageProvider Abstraction

The StorageProvider interface separates application-level storage logic from the actual storage implementation.

This allows different storage backends to implement the same operations.

### 5.3 PARW File Format

GitVault uses a custom .parw container format for storing files.

It provides:

* Compression using Zstandard when beneficial.
* Raw storage when compression does not reduce file size.
* File metadata.
* SHA-256 integrity verification.

### 5.4 Multiple Repository Management

Instead of relying on a single repository, GitVault manages multiple repositories as one logical storage volume.

RepositoryManager handles repository allocation and estimated capacity tracking.

### 5.5 SQLite Metadata Storage

SQLite is used to maintain file metadata, repository information, and storage accounting.

This avoids having to reconstruct all application-level information from GitHub repositories every time the application starts.

### 5.6 Versioned Storage

GitVault uses Git’s version history to retrieve archived files.

When a file is archived, its original file is removed from the current repository tree and replaced with a pointer.

However, the original Git object remains in repository history. Archiving therefore reduces the current tree footprint but does not immediately reclaim the historical storage occupied by the original file.