# ArtCatch

ArtCatch는 React + NestJS + PostgreSQL 기반의 작품 수집/게시판/AI 도슨트 웹앱입니다.

주요 기능은 다음과 같습니다.

- 작품 컬렉션, 미션, 포인트 기반 보상
- 게시판, 댓글, 투표, 자동 모더레이션
- AI 도슨트 RAG 응답
- 로컬 CLIP 이미지 임베딩 기반 유사 작품 검색
- Vision LLM 재판단 및 MCP 외부 자료 링크 연동

## 기술 스택

- Frontend: React, TypeScript, Vite
- Backend: NestJS, Prisma
- Database: PostgreSQL + pgvector
- AI: OpenAI API, Xenova CLIP
- External Search: MCP stdio search server

## 사전 준비

로컬 실행 전에 아래가 필요합니다.

- Node.js 20 이상
- npm
- Docker Desktop
- Git
- OpenAI API key: AI 도슨트, Vision 재판단 기능 사용 시 필요
- Tavily API key: MCP 외부 자료 검색 기능 사용 시 필요
- Google OAuth client: Google 로그인 사용 시 선택

## 처음 실행하기

Windows PowerShell 기준입니다.

```powershell
git clone -b main https://github.com/Developer-EJ/Intelligent-Board.git
cd Intelligent-Board

Copy-Item .env.example backend\.env
Copy-Item .env.example frontend\.env

npm install
npm run db:up
npm run db:migrate
npm run db:seed
npm run build -w backend
npm run image-embeddings:backfill -w backend
npm run dev
```

실행 후 접속 주소는 아래와 같습니다.

- Frontend: http://127.0.0.1:5173
- Backend: http://127.0.0.1:3001
- 이미지 검색: http://127.0.0.1:5173/#image-search
- AI 도슨트/스캔: http://127.0.0.1:5173/#scan

`npm.ps1` 실행이 막히면 같은 명령을 `cmd /c`로 실행하면 됩니다.

```powershell
cmd /c npm install
cmd /c npm run db:up
cmd /c npm run db:migrate
cmd /c npm run db:seed
cmd /c npm run build -w backend
cmd /c npm run image-embeddings:backfill -w backend
cmd /c npm run dev
```

## 환경 변수

기본값은 `.env.example`에 들어 있습니다. 로컬에서는 `backend/.env`와 `frontend/.env`를 만들고 필요한 값만 채우면 됩니다.

### Backend

`backend/.env`에서 주로 확인할 값입니다.

```env
DATABASE_URL="postgresql://artcatch:artcatch@localhost:5432/artcatch?schema=public"
PORT=3001
FRONTEND_ORIGIN="http://127.0.0.1:5173"

OPENAI_API_KEY="your-openai-api-key"
OPENAI_VISION_MODEL="gpt-5.4-mini"
OPENAI_DOCENT_MODEL="gpt-5.4-mini"
OPENAI_EMBEDDING_MODEL="text-embedding-3-small"

CLIP_IMAGE_MODEL="Xenova/clip-vit-base-patch32"
CLIP_IMAGE_DIMENSIONS=512

MCP_SEARCH_COMMAND="node"
MCP_SEARCH_ARGS_JSON='["dist/mcp/search-server.js"]'
MCP_SEARCH_TOOL="artcatch_external_search"
MCP_SEARCH_INPUT_TEMPLATE_JSON='{"query":"{{query}}","max_results":{{count}}}'
TAVILY_API_KEY="your-tavily-api-key"
```

### Frontend

`frontend/.env`는 기본적으로 아래 값이면 충분합니다.

```env
VITE_API_BASE_URL="/api"
```

Vite 개발 서버가 `/api` 요청을 `http://127.0.0.1:3001` 백엔드로 프록시합니다.

## 이미지 검색 세팅

이미지 검색은 아래 흐름으로 동작합니다.

1. 작품 이미지를 로컬 CLIP으로 임베딩합니다.
2. PostgreSQL pgvector에 이미지 벡터를 저장합니다.
3. 사용자가 업로드한 이미지도 CLIP으로 임베딩합니다.
4. 벡터 유사도로 후보 작품을 찾습니다.
5. Vision LLM이 후보를 다시 비교해 최종 작품과 설명을 만듭니다.

처음 DB를 만들었거나 작품 데이터가 바뀌었으면 한 번 실행합니다.

```powershell
npm run image-embeddings:backfill -w backend
```

첫 실행 시 CLIP 모델을 내려받기 때문에 시간이 걸릴 수 있습니다.

## MCP 외부 자료 검색

이미지 검색 결과에서 `작품 자료 찾기`를 누르면 백엔드가 MCP stdio 서버를 실행해 외부 자료를 검색합니다.

이 기능을 쓰려면 `backend/.env`에 `TAVILY_API_KEY`를 넣고, MCP 서버 파일이 생성되도록 백엔드를 한 번 빌드해야 합니다.

```powershell
npm run build -w backend
```

빌드 산출물은 Git에 포함되지 않으므로, 새로 클론한 환경에서는 반드시 한 번 실행해야 합니다.

## Google 로그인

Google Cloud Console에서 Web application OAuth Client를 만들고 아래 주소를 등록합니다.

- Authorized JavaScript origins: `http://127.0.0.1:5173`, `http://localhost:5173`
- Authorized redirect URIs: `http://127.0.0.1:3001/auth/google/callback`, `http://localhost:3001/auth/google/callback`

그 다음 `backend/.env`에 아래 값을 넣습니다.

```env
GOOGLE_CLIENT_ID="your-client-id"
GOOGLE_CLIENT_SECRET="your-client-secret"
GOOGLE_CALLBACK_URL="http://127.0.0.1:3001/auth/google/callback"
COOKIE_SECURE="false"
```

테스트할 때는 `127.0.0.1` 또는 `localhost` 중 하나만 일관되게 사용하세요. 두 주소를 섞으면 OAuth state/session cookie가 전달되지 않을 수 있습니다.

## 자주 쓰는 명령어

```powershell
npm run dev
npm run dev:frontend
npm run dev:backend
npm run db:up
npm run db:migrate
npm run db:seed
npm run db:down
npm run build -w frontend
npm run build -w backend
```

## 참고

- DB 컨테이너는 `docker-compose.yml`의 `pgvector/pgvector:pg16` 이미지를 사용합니다.
- 활성 구현은 `frontend/`와 `backend/`에 있습니다.
- `data/seed-data.json`은 seed/import 용도이고, 실제 실행 데이터는 PostgreSQL에 저장됩니다.
