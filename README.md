# Slack Mirror (FastAPI + React)

This project mirrors Slack message data into a Node/Express backend (formerly FastAPI) and a Vite/React frontend with a Slack-like UI. It supports two Slack workspaces (RTC and Beta), lists channels/DMs, shows message history, and opens threads.

## Backend (Node/Express)

- Tech: Node 18+, Express, @slack/web-api
- Entrypoint: `server.js`
- Env config (add to `.env` but do **not** commit secrets):
  - `SLACK_SIGNING_SECRET_RTC`
  - `SLACK_CLIENT_ID_RTC` (unused in current code but present in sample env)
  - `SLACK_CLIENT_SECRET_RTC` (unused in current code but present in sample env)
  - `SLACK_USER_TOKEN_RTC`
  - `SLACK_USER_TOKEN_BETA` (named `SLACK_BOT_TOKEN_BETA` in code)
  - `SLACK_SIGNING_SECRET_BETA`
  - `TEAM_RTC`
  - `TEAM_BETA`

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
