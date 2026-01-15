# Slack Mirror (FastAPI + React)

This project mirrors Slack message data into a Node/Express backend (formerly FastAPI) and a Vite/React frontend with a Slack-like UI. It can bridge messages across multiple Slack workspaces, list channels/DMs, show message history, and open threads.

## Backend (Node/Express)

- Tech: Node 18+, Express, @slack/web-api
- Entrypoint: `server.js`
- Env config (add to `.env` but do **not** commit secrets):
  - `SLACK_SIGNING_SECRET`
  - `SLACK_CLIENT_ID`
  - `SLACK_CLIENT_SECRET`
  - `SLACK_USER_TOKEN` (primary workspace token)
  - `PRIMARY_TEAM_ID`
  - Optional display overrides: `PRIMARY_ORG_ID`, `PRIMARY_ORG_NAME`, `PRIMARY_ORG_STATUS`, `PRIMARY_ORG_INITIALS`, `PRIMARY_ORG_ACCENT`

### Run backend
```bash
npm install
npm run dev   # nodemon server.js (default port 8000)
# or
npm start     # node server.js
```

Key API routes:
- `GET /api/organizations` – list configured workspaces
- `GET /api/orgs/{org_id}/chats` – channels + DMs for an org
- `GET /api/chats/{chat_id}/messages?org_id=...` – message history
- `GET /api/chats/{chat_id}/thread?org_id=...&thread_ts=...` – thread parent + replies

## Frontend (React/Vite)

- Located in `frontend/`
- Dev server proxies `/api` to `http://127.0.0.1:8000`

### Run frontend
```bash
cd frontend
npm install
npm run dev   # http://localhost:5173
```

### Build
```bash
cd frontend
npm run build
```

## Notes
- Keep `.env` out of git; add it to `.gitignore` before pushing.
- The backend loads `.env` automatically at startup; ensure tokens are valid for Slack APIs.
- Slack rate limits apply when listing many channels/DMs; consider caching if needed.
