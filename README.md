# ArtCatch

ArtCatch has been restructured as a React + Nest.js + PostgreSQL app.

## Stack

- Frontend: React, TypeScript, Vite
- Backend: Nest.js, Prisma
- DB: PostgreSQL

## Local Run

Start Docker Desktop first, then run:

```powershell
cd C:\artcollection_memo
copy .env.example backend\.env
copy .env.example frontend\.env
npm install
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

Frontend: http://127.0.0.1:5173

Backend: http://127.0.0.1:3001

AI similarity judging is wired through the React + Nest app only. Use
`npm run dev` or `start-artcatch.cmd` and open `http://127.0.0.1:5173/#scan`.

If PowerShell blocks `npm.ps1`, use the same commands through `cmd /c`:

```powershell
cmd /c npm install
cmd /c npm run db:up
cmd /c npm run db:migrate
cmd /c npm run db:seed
cmd /c npm run dev
```

## Google Login

Create a Google OAuth Client ID for a Web application, then add these local
development URLs in Google Cloud Console:

- Authorized JavaScript origins: `http://127.0.0.1:5173`, `http://localhost:5173`
- Authorized redirect URIs: `http://127.0.0.1:3001/auth/google/callback`, `http://localhost:3001/auth/google/callback`

Set these values in `backend/.env`:

```powershell
GOOGLE_CLIENT_ID="your-client-id"
GOOGLE_CLIENT_SECRET="your-client-secret"
GOOGLE_CALLBACK_URL="http://127.0.0.1:3001/auth/google/callback"
COOKIE_SECURE="false"
```

Use one host consistently while testing. The default project URLs use
`127.0.0.1`; if you open the frontend as `http://localhost:5173`, also change
`FRONTEND_ORIGIN` and `GOOGLE_CALLBACK_URL` to `localhost` values and register
those exact URLs in Google Cloud Console. Mixing `localhost` and `127.0.0.1`
can prevent the OAuth state/session cookies from being sent.

## Notes

The active implementation lives in `frontend/` and `backend/`.
