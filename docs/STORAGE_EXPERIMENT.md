# Storage Experiment

The Storage Experiment explores how archiving affects repository storage. Archiving removes a file from the current tree, but Git keeps the historical object, so current tree size and total repository size diverge.

Run it with:

```bash
npm run experiment
```

or through `POST /api/experiment/run`.

## What it does

For each selected file size:

1. Generate a test file.
2. Encode it into PARW format.
3. Upload it to the selected backend.
4. Record storage statistics.
5. Archive the file.
6. Record storage statistics again.
7. Restore the file from Git history.
8. Verify its SHA-256 checksum.
9. Restore it into the current repository tree.
10. Record the final statistics.

## What it reports

| Metric | Description |
|---|---|
| Current tree bytes | Size of files in the current repository tree |
| Estimated repository size | Repository size reported by the backend, where available |
| Historical bytes | Application-level estimate of retained historical data |
| Commits | Number of commits reported by the backend |
| Binary objects | Binary object information, where available |
| Timings | Time taken by the different operations |

## Caveats

- GitHub does not expose exact historical object-storage consumption through the REST API. GitHub figures are estimates or may be unavailable.
- A local experiment validates the application workflow and checksum logic only.
- A real GitHub experiment is needed to observe how GitHub reports repository size after archiving.