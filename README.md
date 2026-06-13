# ArtCatch

ArtCatch has been restructured as a React + Nest.js + PostgreSQL app.

## Stack

- Frontend: React, TypeScript, Vite
- Backend: Nest.js, Prisma
- DB: PostgreSQL

## Local Run

Start Docker Desktop first, then run:

```powershell
cd C:\new_project
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
The root-level `dev-server.mjs` is the older local prototype and does not call
the AI mission analysis API.

If PowerShell blocks `npm.ps1`, use the same commands through `cmd /c`:

```powershell
cmd /c npm install
cmd /c npm run db:up
cmd /c npm run db:migrate
cmd /c npm run db:seed
cmd /c npm run dev
```

## Notes

The previous vanilla JavaScript prototype remains in the project root for reference.
The new implementation lives in `frontend/` and `backend/`.
