# PARW Container Format

PARW is a custom file-container format designed for GitVault. It uses Zstandard compression when that reduces size, and stores the original bytes uncompressed when it does not.

## Layout

```
+-------------------------+
| Magic: "PARW"           |
+-------------------------+
| Version (u16)           |
+-------------------------+
| Metadata length (u32)   |
+-------------------------+
| Metadata (JSON)         |
+-------------------------+
| Payload                 |
+-------------------------+
```

All integer fields are big-endian.

## Metadata

The JSON metadata block contains:

- Original filename
- File extension
- MIME type
- Original file size
- Compression method (`zstd` or `none`)
- Original SHA-256 checksum
- Compressed payload size

## Integrity verification

GitVault keeps two separate checksums:

| Checksum | Purpose |
|---|---|
| Original SHA-256 | Verifies the decoded file against the original content |
| PARW SHA-256 | Verifies the encoded container before decoding |

The decoder validates the magic bytes, version, metadata length, decompressed size, and checksum. Decompression limits are applied to protect against oversized or malicious payloads.

## CLI

```bash
npm run parw:encode -- file
npm run parw:decode -- file.parw
```