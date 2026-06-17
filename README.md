# ArtCatch

ArtCatch는 미술 작품 감상, 미션형 컬렉션, 게시판 커뮤니티, AI 도슨트, 이미지 유사 작품 검색을 하나의 흐름으로 묶은 지능형 미술 감상 웹 서비스입니다. 사용자는 작품을 둘러보고, 오늘의 미션을 수행하고, 이미지 검색 결과를 게시판에 공유하며, AI 도슨트와 대화하거나 외부 자료를 함께 확인할 수 있습니다.

## 1. 프로젝트 개요

### 목표

- 미술 작품 감상을 단순 조회가 아니라 미션, 컬렉션, 커뮤니티 활동으로 확장합니다.
- 사용자의 질문에 대해 RAG 기반 AI 도슨트가 현재 서비스 데이터 안에서 답변합니다.
- 사용자가 업로드한 사진과 유사한 작품을 Local CLIP + pgvector + Vision LLM으로 찾고 설명합니다.
- 게시판에는 Auto-Mod Agent를 붙여 게시글/댓글의 위험 표현을 사전 검토합니다.
- MCP stdio 서버를 통해 이미지 검색 결과와 연결되는 외부 작품 자료 검색 흐름을 보여줍니다.

### 기술 스택

| 영역 | 기술 |
| --- | --- |
| Frontend | React, TypeScript, Vite |
| Backend | NestJS, TypeScript |
| ORM | Prisma |
| Database | PostgreSQL, pgvector |
| AI | OpenAI LLM, OpenAI Vision-capable LLM, OpenAI Embeddings |
| Image Embedding | Xenova Local CLIP |
| External Tool | MCP stdio Search Server, Tavily |
| Infra | Docker Compose |

### 실행 방법

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

실행 주소:

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:3001`
- 이미지 검색: `http://127.0.0.1:5173/#image-search`
- AI 도슨트: `http://127.0.0.1:5173/#docent`
- 게시판: `http://127.0.0.1:5173/#community`

주요 환경 변수:

```env
DATABASE_URL="postgresql://artcatch:artcatch@localhost:5432/artcatch?schema=public"
PORT=3001
FRONTEND_ORIGIN="http://127.0.0.1:5173"

OPENAI_API_KEY="your-openai-api-key"
OPENAI_DOCENT_MODEL="gpt-5.4-mini"
OPENAI_VISION_MODEL="gpt-5.4-mini"
OPENAI_EMBEDDING_MODEL="text-embedding-3-small"

CLIP_IMAGE_MODEL="Xenova/clip-vit-base-patch32"
CLIP_IMAGE_DIMENSIONS=512

MCP_SEARCH_COMMAND="node"
MCP_SEARCH_ARGS_JSON='["dist/mcp/search-server.js"]'
MCP_SEARCH_TOOL="artcatch_external_search"
MCP_SEARCH_INPUT_TEMPLATE_JSON='{"query":"{{query}}","max_results":{{count}}}'
TAVILY_API_KEY="your-tavily-api-key"
```

## 2. 주요 구현 기능

### 작품 감상 및 컬렉션

- 국내/해외 미술관 기준 작품 데이터 조회
- 작품 상세 이미지, 작가, 연도, 시대, 태그 정보 제공
- 오늘의 미션 완료 시 포인트와 컬렉션 기록 저장
- 포인트 기반 보상 작품 구매 및 컬렉션 확장

### 이미지 유사 작품 검색

- 사용자가 업로드한 사진을 Local CLIP으로 이미지 임베딩
- DB에 저장된 작품 이미지 임베딩과 pgvector 유사도 검색
- 검색 후보를 OpenAI Vision LLM이 다시 비교해 최종 작품 선정
- 유사한 부분과 다른 부분을 자연어로 설명
- 검색 결과를 게시판 글 초안으로 공유
- 공유 시 사용자가 업로드한 사진 썸네일과 매칭 메타데이터를 함께 저장

### AI 도슨트

- 사용자의 질문을 임베딩해 관련 작품 지식을 검색
- 작품 메타데이터, 미션 힌트, 미술관 출처 정보를 컨텍스트로 구성
- 검색된 컨텍스트만 기반으로 답변하도록 제한
- 추천 작품과 응답 근거 source를 함께 반환

### 게시판

- 자유게시판/후기게시판
- 게시글, 댓글, 대댓글, 추천/비추천
- 태그 입력 및 필터링
- 이미지 검색 결과 공유 게시글 지원
- Auto-Mod Agent 기반 게시글/댓글 사전 검토

### MCP 외부 자료 검색

- 이미지 검색 결과 또는 공유 게시글에서 작품 외부 자료 검색
- 백엔드가 MCP stdio Search Server를 실행
- MCP tool call을 통해 Tavily/Web Sources 검색
- 결과 링크를 UI에 표시

## 3. 전체 아키텍처 구조

아래 이미지는 ArtCatch의 전체 시스템 흐름을 요약한 아키텍처 다이어그램입니다.

![ArtCatch architecture overview](artifacts/architecture-overview.png)

Mermaid로 정리한 상세 구조는 다음과 같습니다.

```mermaid
flowchart LR
  User["User"] --> FE["React Frontend<br/>Vite"]
  FE --> BE["NestJS Backend"]

  BE --> Auth["Auth Module"]
  BE --> Artwork["Artwork/Museum Module"]
  BE --> Board["Board/Post Module"]
  BE --> Collection["Collection Module"]
  BE --> Mission["Mission Module"]
  BE --> Docent["AI Docent Module"]
  BE --> ImageSearch["Image Search Module"]
  BE --> External["External Search Module"]

  Auth --> Prisma["Prisma ORM"]
  Artwork --> Prisma
  Board --> Prisma
  Collection --> Prisma
  Mission --> Prisma
  Docent --> Prisma
  ImageSearch --> Prisma

  Prisma --> DB["PostgreSQL<br/>pgvector"]

  Board --> AutoMod["Auto-Mod Agent"]
  AutoMod --> OpenAIText["OpenAI Text LLM"]

  Docent --> Embedding["OpenAI Embeddings"]
  Docent --> OpenAIText
  Embedding --> DB

  ImageSearch --> CLIP["Local CLIP<br/>Xenova"]
  CLIP --> ImageSearch
  ImageSearch --> Vision["OpenAI Vision-capable LLM"]
  ImageSearch --> DB

  Mission --> Vision
  Mission --> Embedding

  External --> MCP["MCP stdio Search Server"]
  MCP --> Tavily["Tavily / Web Sources"]
```

### 구조 해석

- `Prisma ORM`은 NestJS 서비스 코드와 PostgreSQL 사이에서 DB 접근을 담당합니다.
- `PostgreSQL + pgvector`는 일반 서비스 데이터와 벡터 검색용 데이터를 함께 저장합니다.
- `OpenAI Text LLM`은 도슨트 답변, 게시판 검열 판단, Agent planner/judge에 사용됩니다.
- `OpenAI Vision-capable LLM`은 이미지 입력을 함께 받아 미션 사진 판정과 이미지 검색 후보 재판단에 사용됩니다.
- `Local CLIP`은 이미지 자체를 벡터로 바꾸는 로컬 모델입니다. 이미지 검색에서 검색용 후보를 빠르게 찾는 역할입니다.
- `MCP`는 백엔드가 직접 웹 검색 API를 호출하는 것이 아니라, MCP 서버의 tool을 호출하는 외부 도구 연결 구조입니다.

## 4. 각 AI 활용 기능, 기술, 아키텍처 구조

### RAG 기능

AI 도슨트는 RAG 구조를 사용합니다. 사용자 질문을 그대로 LLM에 보내는 것이 아니라, 먼저 질문을 임베딩하고 DB 안의 작품 지식 벡터와 비교해 관련 컨텍스트를 찾습니다.

```mermaid
flowchart TD
  Q["사용자 질문"] --> Embed["OpenAI Embeddings<br/>createEmbeddings([message])"]
  Embed --> Vector["Query Embedding"]
  Vector --> Search["pgvector 유사도 검색<br/>ArtworkKnowledge"]
  Search --> Context["관련 작품 지식 Context"]
  Context --> Prompt["도슨트 프롬프트 구성"]
  Q --> Prompt
  Prompt --> LLM["OpenAI Text LLM"]
  LLM --> Answer["답변 + 추천 작품 + Sources"]
```

구현 위치:

- 사용자 질문 임베딩: `backend/src/ai-docent/ai-docent.service.ts`의 `createEmbeddings([message])`
- 지식 후보 검색: `findKnowledgeCandidates(queryEmbedding, knowledgeScopeIds)`
- pgvector 검색: `findKnowledgeCandidatesWithPgVector(...)`
- 최종 답변 생성: `generateDocentAnswer(...)`

RAG에 들어가는 지식은 `ArtworkKnowledge`로 저장됩니다.

- `metadata`: 작품명, 작가, 연도, 시대, 분류, 태그, 색상 등
- `mission_hint`: 사용자가 따라 찍기 좋은 구도/분위기 힌트
- `museum`: 작품 이미지 출처와 미술관/공개 컬렉션 맥락

보조적으로 Mission Module도 유사한 벡터 검색을 사용합니다. 미션 분석 결과를 임베딩해 이전 성공/실패 패턴과 비교하고, 유사한 기록이 있으면 코칭 힌트를 제공합니다.

### MCP 기능

MCP 기능은 이미지 검색 결과에서 외부 자료를 확인할 때 사용됩니다. 사용자가 `작품 자료 찾기`를 누르면 프론트는 백엔드의 `/external-search` API를 호출하고, 백엔드는 MCP stdio 서버와 통신합니다.

```mermaid
flowchart TD
  User["사용자: 작품 자료 찾기"] --> FE["Frontend"]
  FE --> API["GET /external-search?q=..."]
  API --> Service["ExternalSearchService"]
  Service --> MCP["MCP stdio Search Server"]
  MCP --> Tool["artcatch_external_search tool"]
  Tool --> Tavily["Tavily / Web Sources"]
  Tavily --> Tool
  Tool --> MCP
  MCP --> Service
  Service --> FE
  FE --> UI["외부 자료 링크 표시"]
```

MCP의 역할은 외부 검색을 백엔드 내부 함수로 고정하지 않고, 표준화된 tool 호출 흐름으로 분리하는 것입니다.

- MCP command: `MCP_SEARCH_COMMAND`
- MCP args: `MCP_SEARCH_ARGS_JSON`
- MCP tool name: `MCP_SEARCH_TOOL`
- 검색 provider: Tavily

이 구조 덕분에 Tavily 외에도 다른 검색 서버나 사내 자료 검색 서버로 교체하기 쉽습니다.

### Agent 기능

Auto-Mod Agent는 게시글/댓글 작성 전에 표현을 검토합니다. 단순 금칙어 필터가 아니라, 상태를 가진 reasoning loop 안에서 필요한 도구를 선택하고 실행합니다.

```mermaid
flowchart TD
  Input["게시글/댓글 작성"] --> Rule["rule_check"]
  Rule --> Planner["LLM Planner"]

  Planner --> Thread["thread_context_check"]
  Planner --> History["history_check"]
  Planner --> Judge["llm_judge"]
  Planner --> Decide["decide_action"]

  Thread --> Planner
  History --> Planner
  Judge --> Planner

  Decide --> Result["allow / warn / hold / report"]
```

Agent 구성 요소:

- `rule_check`: 정규식/룰 기반으로 욕설, 위협, 개인정보 노출 등 빠른 1차 탐지
- `thread_context_check`: 댓글의 부모 댓글, 최근 댓글, 게시글 맥락 확인
- `history_check`: 작성자의 최근 경고/보류/신고 이력 확인
- `llm_judge`: OpenAI LLM이 맥락 기반으로 표현 위험도를 판단
- `decide_action`: 수집된 결과를 종합해 최종 조치 결정

Agent로 볼 수 있는 이유:

- Function Calling 기반 도구 선택 구조를 사용합니다.
- `AutoModState`에 입력, findings, threadContext, history, llmDecision, steps를 저장합니다.
- LLM Planner가 다음 도구를 선택합니다.
- 최대 실행 스텝을 제한해 무한 루프를 방지합니다.
- OpenAI 실패 시 deterministic fallback이 있습니다.

한계도 있습니다. 댓글 등록 시 이 검열 루프를 동기적으로 기다리기 때문에, OpenAI 응답이 느리면 댓글 등록도 느려질 수 있습니다.

### 이미지 검색 AI 구조

이미지 검색은 RAG라기보다는 멀티모달 검색 + Vision 재판단 구조입니다.

```mermaid
flowchart TD
  Upload["사용자 업로드 이미지"] --> ClipQuery["Local CLIP 임베딩"]
  ClipQuery --> PgSearch["pgvector 유사 이미지 검색"]
  PgSearch --> Candidates["후보 작품 N개"]
  Candidates --> Vision["OpenAI Vision LLM 재랭킹"]
  Upload --> Vision
  Vision --> Final["최종 매칭 작품"]
  Final --> Explain["유사/차이 설명"]
  Explain --> Share["게시판 공유 초안"]
```

역할 분리:

- Local CLIP: 이미지를 512차원 벡터로 변환
- pgvector: 작품 이미지 벡터와 사용자 이미지 벡터를 빠르게 비교
- Vision LLM: CLIP 후보를 다시 보고 실제 시각적 유사성, 차이점, 설명을 생성

## 5. 데모

### 실행 데모 경로

- 홈/미션: `http://127.0.0.1:5173/#scan`
- 작품 소개: `http://127.0.0.1:5173/#artworks`
- 이미지 검색: `http://127.0.0.1:5173/#image-search`
- 게시판: `http://127.0.0.1:5173/#community`
- AI 도슨트: `http://127.0.0.1:5173/#docent`

### 스크린샷

Auto-Mod Agent가 위험 표현을 감지해 게시글 업로드를 차단하는 화면입니다.

![Auto-Mod demo](artifacts/automod-write-blocked-final.png)

### 주요 시연 흐름

1. 이미지 검색 페이지에서 사진을 업로드합니다.
2. Local CLIP이 현재 사이트 내 작품 기준으로 후보를 찾습니다.
3. Vision LLM이 후보를 다시 비교해 가장 유사한 작품과 설명을 반환합니다.
4. `작품 자료 찾기`를 눌러 MCP 외부 자료 검색 결과를 확인합니다.
5. 검색 결과를 게시판에 공유하면 업로드 사진 썸네일과 매칭 메타데이터가 함께 게시글에 저장됩니다.
6. 게시글/댓글 작성 시 Auto-Mod Agent가 위험 표현을 사전 검토합니다.

## 6. 회고, 한계점, 그리고 개선 아이디어

### 회고

이번 프로젝트는 단순히 OpenAI API를 호출하는 기능보다, 여러 AI 사용 방식을 하나의 서비스 플로우 안에 녹이는 데 초점을 뒀습니다.

- RAG는 AI 도슨트의 답변 신뢰성을 높이는 역할을 했습니다.
- Local CLIP은 이미지 검색 후보를 빠르게 좁히는 역할을 했습니다.
- Vision LLM은 단순 벡터 유사도만으로 부족한 시각적 설명을 보완했습니다.
- MCP는 외부 자료 검색을 표준 tool 호출 구조로 분리했습니다.
- Auto-Mod Agent는 게시판 기능에 실제 운영형 AI 판단 흐름을 붙였습니다.

### 한계점

- 이미지 검색 정확도는 CLIP 모델의 표현력과 작품 이미지 품질에 영향을 많이 받습니다.
- CLIP 유사도가 높다고 해서 사람이 보기에 반드시 비슷한 작품은 아닙니다.
- Vision LLM 재랭킹은 품질을 높이지만 응답 시간이 길어질 수 있습니다.
- Auto-Mod Agent는 댓글 등록 전에 동기 실행되어 UX가 느려질 수 있습니다.
- RAG 지식은 현재 DB에 저장된 작품 메타데이터에 강하게 의존합니다.
- MCP 검색 결과는 외부 검색 품질과 Tavily API 응답에 영향을 받습니다.
- 현재는 관리자 검수 UI가 제한적이라 hold/report 이후 운영 흐름이 더 필요합니다.

### 개선 아이디어

- 댓글/게시글 등록 시 낙관적 UI 업데이트와 비동기 검열 큐를 도입합니다.
- Auto-Mod 결과를 관리자 대시보드에서 검수/해제할 수 있게 합니다.
- 이미지 검색용 CLIP 모델을 더 큰 모델 또는 도메인 특화 모델로 교체합니다.
- 작품 이미지 크롭, 배경 제거, 색상 히스토그램 등 보조 특징을 결합합니다.
- RAG 지식에 외부 미술관 공식 설명, 작가 설명, 시대 배경을 추가합니다.
- MCP 검색 서버를 Tavily 외에도 공식 미술관 API, 위키데이터, 자체 문서 검색으로 확장합니다.
- 질문 임베딩 캐시와 인기 질문 캐시를 추가해 AI 도슨트 응답 속도를 개선합니다.
- 이미지 검색 결과에 “동일성 증거가 아닌 시각적 유사성 추천”이라는 UX 가이드를 더 명확히 제공합니다.
