# API Reference

The backend listens on `http://127.0.0.1:3001` by default (see `PORT`).

## Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/auth/status` | Check backend connection status |
| GET | `/api/settings` | Retrieve application settings and limits |
| GET | `/api/files` | List stored files |
| GET | `/api/tree` | Retrieve the virtual folder tree |
| POST | `/api/files?path=a/b.jpg` | Upload a file using a raw binary request body |
| POST | `/api/files/preview?path=` | Preview encoding and repository allocation without uploading |
| GET | `/api/files/download?path=` | Download an active file after checksum verification |
| POST | `/api/files/archive` | Archive a file by replacing it with a pointer |
| POST | `/api/files/restore` | Restore a file from Git history |
| GET | `/api/repositories` | List configured repositories and usage estimates |
| GET | `/api/experiment/dashboard` | Retrieve storage experiment statistics |
| POST | `/api/experiment/run` | Run the storage experiment |
| GET | `/api/auth/github/login` | Start GitHub OAuth authentication |
| GET | `/api/auth/github/callback` | Handle the OAuth callback |
| POST | `/api/auth/logout` | Disconnect the GitHub account |

## Notes

- The upload endpoint takes the file bytes directly as the request body. It does **not** use multipart form data.
- State-changing requests are only accepted from the origin set in `CLIENT_ORIGIN`.

## Example

```bash
# Upload
curl -X POST --data-binary @report.pdf \
  "http://127.0.0.1:3001/api/files?path=documents/report.pdf"

# Download (checksums are verified server-side)
curl -o report.pdf \
  "http://127.0.0.1:3001/api/files/download?path=documents/report.pdf"
```