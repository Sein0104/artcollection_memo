import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { CSSProperties, ChangeEvent, ReactNode } from "react";
import type {
  AiDocentSource,
  Artwork,
  DailyMissions,
  ExternalSearchResult,
  ExternalSearchResponse,
  ImageSearchMatch,
  ImageSearchResponse,
  MissionAnalysis,
  ModerationNotice,
  Museum,
  Post,
  PostComment,
  PostDetail,
  Session,
  UserState,
} from "./types";

const emptyState: UserState = {
  points: 0,
  totalEarnedPoints: 0,
  installedRewardId: null,
  collection: [],
  missionCollection: [],
  purchases: [],
};

const tabs = [
  { id: "scan", label: "홈" },
  { id: "artworks", label: "작품 소개" },
  { id: "image-search", label: "이미지 검색" },
  { id: "collection", label: "컬렉션" },
  { id: "community", label: "게시판" },
  { id: "docent", label: "AI 도우미" },
];

const titleSteps = [
  [4000, "마스터 큐레이터"],
  [3000, "컬렉션 디렉터"],
  [2400, "명예 수집가"],
  [1800, "전시 기획자"],
  [1200, "큐레이터 후보"],
  [800, "작품 탐험가"],
  [500, "갤러리 산책자"],
  [200, "신진 감상가"],
  [0, "새내기 감상가"],
] as const;

const artworkFilters = ["전체", "서양", "동양", "한국화", "조각", "설치예술", "공예", "미디어아트", "현대", "인상주의", "추상", "초상", "풍경", "수묵"];
const collectionProgressFilters = artworkFilters.filter((filter) => filter !== "전체");
const boardHiddenMuseumIds = new Set(["national-museum"]);
const deletedCommentBody = "삭제된 댓글입니다.";

type SortMode = "name" | "year";
type BoardType = "free" | "review";
type BoardFilter = "all" | BoardType | "popular";
type DocentChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  suggestedArtworks?: Artwork[];
  sources?: AiDocentSource[];
};

type ImageShareMetadata = {
  kind: "image-search-share";
  artwork: Artwork;
  similarity: number;
  explanation?: ImageSearchResponse["explanation"];
  sources: ExternalSearchResult[];
  sourceQuery: string;
  uploadedImage?: {
    dataUrl: string;
    caption: string;
  };
};

type ImageShareDraft = {
  title: string;
  body: string;
  boardType: BoardType;
  withoutMuseum: boolean;
  metadata: ImageShareMetadata;
};

const docentQuickPrompts = [
  "노을이나 하늘 느낌으로 따라 찍기 좋은 작품 추천해줘",
  "오늘의 미션 작품 힌트를 알려줘",
  "강한 색감이 인상적인 작품을 찾아줘",
  "인상주의 작품에는 뭐가 있어?",
];

const artworkTextTranslations: Record<string, string> = {
  "american painting and sculpture": "미국 회화·조각",
  "modern european painting and sculpture": "근현대 유럽 회화·조각",
  "european painting and sculpture": "유럽 회화·조각",
  "painting and sculpture of europe": "유럽 회화·조각",
  "arts of the americas": "아메리카 미술",
  "art of the americas": "아메리카 미술",
  "arts of asia": "아시아 미술",
  "arts of africa": "아프리카 미술",
  "japanese art": "일본 미술",
  "greek and roman art": "그리스·로마 미술",
  "prints and drawings": "판화와 드로잉",
  prints: "판화",
  "modern art": "현대미술",
  "architecture and design": "건축과 디자인",
  "applied arts of europe": "유럽 응용미술",
  "south asian": "남아시아 미술",
  pointillism: "점묘주의",
  impressionism: "인상주의",
  "post-impressionism": "후기인상주의",
  modernism: "모더니즘",
  "modern european": "근현대 유럽",
  renaissance: "르네상스",
  realism: "사실주의",
  rococo: "로코코",
  baroque: "바로크",
  "19th century": "19세기",
  "nineteenth century": "19세기",
  georgian: "조지아 시대",
  painting: "회화",
  sculpture: "조각",
  ceramic: "도자",
  print: "판화",
  photograph: "사진",
  textile: "섬유",
  vessel: "기물",
  miniature: "미니어처",
  "architectural fragment": "건축 부재",
  "oil on canvas": "캔버스에 유채",
  "oil on fabric": "천에 유채",
  "oil on panel": "패널에 유채",
  "oil on wood panel": "목판에 유채",
  marble: "대리석",
  bronze: "청동",
  terracotta: "테라코타",
  "glazed terracotta": "유약을 바른 테라코타",
  "polychromed terracotta": "채색 테라코타",
  "color woodblock print": "채색 목판화",
  "woodblock print": "목판화",
  "ink and color on paper": "종이에 먹과 채색",
  pastel: "파스텔",
  "mixed media": "혼합 매체",
  america: "미국",
  france: "프랑스",
  italy: "이탈리아",
  england: "영국",
  netherlands: "네덜란드",
  germany: "독일",
  japan: "일본",
  greece: "그리스",
  venice: "베네치아",
  florence: "피렌체",
  holland: "네덜란드",
};

const artworkTextReplacements: Array<[RegExp, string]> = [
  [/(\d+)(st|nd|rd|th)\s+century/gi, "$1세기"],
  [/\bEdo period\b/gi, "에도 시대"],
  [/\bculture or style\b/gi, "문화권"],
  [/\bProbably\b/gi, "추정"],
  [/\bearly\b/gi, "초"],
  [/\bmid\b/gi, "중반"],
  [/\bSouth\b/g, "남부"],
  [/\bNew York\b/g, "뉴욕"],
  [/\bTuscany\b/g, "토스카나"],
  [/\bAttic\b/g, "아티카"],
  [/\bCampanian\b/g, "캄파니아"],
  [/\bAmerica\b/g, "미국"],
  [/\bAmerican\b/g, "미국"],
  [/\bFrance\b/g, "프랑스"],
  [/\bFrench\b/g, "프랑스"],
  [/\bItaly\b/g, "이탈리아"],
  [/\bItalian\b/g, "이탈리아"],
  [/\bEngland\b/g, "영국"],
  [/\bBritish\b/g, "영국"],
  [/\bNetherlands\b/g, "네덜란드"],
  [/\bDutch\b/g, "네덜란드"],
  [/\bGermany\b/g, "독일"],
  [/\bJapan\b/g, "일본"],
  [/\bJapanese\b/g, "일본"],
  [/\bGreece\b/g, "그리스"],
  [/\bGreek\b/g, "그리스"],
  [/\bRome\b/g, "로마"],
  [/\bRoman\b/g, "로마"],
  [/\bFlorence\b/g, "피렌체"],
  [/\bVenice\b/g, "베네치아"],
  [/\bcentury\b/gi, "세기"],
  [/border added/gi, "테두리 추가"],
  [/original built/gi, "원 건축"],
  [/original demolished/gi, "원형 철거"],
  [/reconstructed/gi, "재구성"],
  [/\bc\.\s*/gi, "약 "],
];

const boardTabs: Array<{ id: BoardFilter; label: string }> = [
  { id: "all", label: "전체 글" },
  { id: "free", label: "자유게시판" },
  { id: "review", label: "후기게시판" },
  { id: "popular", label: "추천글" },
];

const boardTypeLabels: Record<BoardType, string> = {
  free: "자유",
  review: "후기",
};

const BOARD_POSTS_PER_PAGE = 8;
const IMAGE_SHARE_DRAFT_KEY = "artcatch:image-search-share-draft";
const IMAGE_SHARE_MARKER_PREFIX = "[[ARTCATCH_IMAGE_SHARE:";
const IMAGE_SHARE_MARKER_SUFFIX = "]]";
const IMAGE_SHARE_PREVIEW_MAX_SIZE = 420;
const IMAGE_SHARE_PREVIEW_MAX_CHARS = 45_000;

function moderationNoticeMessage(notice?: ModerationNotice) {
  if (!notice) return "";
  if (notice.action === "warn") return notice.authorMessage || "표현을 조금 부드럽게 다듬어 주세요.";
  if (notice.action === "hold") return notice.authorMessage || "표현에 주의가 필요한 내용이 감지되었어요. 등록은 완료되었지만 표현을 조금 부드럽게 다듬어 주세요.";
  if (notice.action === "report") {
    return notice.authorMessage || "비하, 모욕, 위협, 개인정보 노출 위험이 감지되어 업로드되지 않았어요. 표현을 수정한 뒤 다시 시도해주세요.";
  }
  return "";
}

function isModerationBlocked(notice?: ModerationNotice) {
  return notice?.action === "report";
}

function routeFromHash() {
  const value = window.location.hash.replace("#", "");
  if (value.startsWith("post/")) return value;
  return ["scan", "artworks", "image-search", "collection", "community", "docent", "write", "login"].includes(value) ? value : "scan";
}

function boardMuseums(museums: Museum[]) {
  return museums.filter((museum) => !boardHiddenMuseumIds.has(museum.id));
}

function boardMuseumName(post: Post | PostDetail) {
  return boardHiddenMuseumIds.has(post.museumId) ? "" : post.museumName ?? "";
}

function pageNumbers(currentPage: number, totalPages: number) {
  const start = Math.max(1, Math.min(currentPage - 2, totalPages - 4));
  const end = Math.min(totalPages, start + 4);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [artworks, setArtworks] = useState<Artwork[]>([]);
  const [museums, setMuseums] = useState<Museum[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [daily, setDaily] = useState<DailyMissions | null>(null);
  const [session, setSession] = useState<Session>({ user: null, state: emptyState });
  const [toast, setToast] = useState("");
  const [selectedImage, setSelectedImage] = useState<Artwork | null>(null);
  const [isTitleGuideOpen, setIsTitleGuideOpen] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [bootstrapError, setBootstrapError] = useState("");

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    void bootstrap();
  }, []);

  async function bootstrap() {
    setIsBootstrapping(true);
    setBootstrapError("");
    try {
      const [artworkResult, museumResult, postResult, missionResult] = await Promise.all([
        api.artworks(),
        api.museums(),
        api.posts(),
        api.dailyMissions(),
      ]);
      setArtworks(artworkResult.artworks);
      setMuseums(museumResult.museums);
      setPosts(postResult.posts);
      setDaily(missionResult);

      const restored = await api.me();
      setSession(restored);
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : "api_error");
    } finally {
      setIsBootstrapping(false);
    }
  }

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  function updateState(state: UserState) {
    setSession((current) => ({ ...current, state }));
  }

  async function logout() {
    try {
      const result = await api.logout();
      setSession(result);
    } catch {
      setSession({ user: null, state: emptyState });
    }
    showToast("로그아웃했습니다.");
  }

  async function completeMission(artworkId: string) {
    if (!session.user) {
      window.location.hash = "#login";
      showToast("로그인 후 미션을 완료할 수 있어요.");
      return;
    }
    try {
      const result = await api.completeMission(artworkId);
      updateState(result.state);
      showToast("미션을 완료하고 80P를 받았습니다.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      showToast(
        message === "daily_mission_limit"
          ? "오늘 미션은 3개까지 가능합니다."
          : message === "mission_analysis_required"
            ? "AI 판정을 통과한 뒤 수집할 수 있어요."
            : "미션을 완료하지 못했습니다.",
      );
    }
  }

  async function buyReward(artworkId: string) {
    if (!session.user) {
      window.location.hash = "#login";
      showToast("로그인 후 교환할 수 있어요.");
      return;
    }
    const result = await api.buyReward(artworkId);
    updateState(result.state);
    showToast("보상 작품을 설치했습니다.");
  }

  const earnedPoints = session.state.totalEarnedPoints ?? session.state.points;
  const title = titleSteps.find(([min]) => earnedPoints >= min)?.[1] ?? "새내기 감상가";
  const postId = route.startsWith("post/") ? route.slice("post/".length) : null;
  const activeNav = postId || route === "write" ? "community" : route;
  const collectionCount = session.state.collection.length + session.state.missionCollection.length + session.state.purchases.length;

  return (
    <>
      <header className="topbar">
        <a className="brand" href="#scan">
          <span className="brand-mark">A</span>
          <span>
            <strong>ArtCatch</strong>
          </span>
        </a>
        <nav className="nav-links">
          {tabs.map((tab) => (
            <a key={tab.id} className={activeNav === tab.id ? "is-active" : ""} href={`#${tab.id}`}>
              {tab.label}
            </a>
          ))}
        </nav>
        <div className="auth-area">
          {session.user ? (
            <div className="user-pill">
              <span>{session.user.nickname}</span>
              <button className="ghost-button" onClick={() => void logout()}>
                로그아웃
              </button>
            </div>
          ) : (
            <div className="auth-buttons">
              <a className="primary-link" href="#login">
                Google 로그인
              </a>
            </div>
          )}
        </div>
      </header>

      <main>
        {route !== "scan" && (
          <section className="status-strip">
            <button className="status-tile title-tile" type="button" onClick={() => setIsTitleGuideOpen(true)}>
              <span className="label">칭호</span>
              <strong>{title}</strong>
            </button>
            <div className="status-tile">
              <span className="label">포인트</span>
              <strong>{session.state.points}P</strong>
            </div>
            <div className="status-tile">
              <span className="label">수집</span>
              <strong>{collectionCount}점</strong>
            </div>
          </section>
        )}

        {(isBootstrapping || bootstrapError) && (
          <ApiNotice
            error={bootstrapError}
            isLoading={isBootstrapping}
            onRetry={() => {
              void bootstrap();
            }}
          />
        )}

        {route === "scan" && (
          <ScanPage
            artworks={artworks}
            daily={daily}
            session={session}
            title={title}
            points={session.state.points}
            collectionCount={collectionCount}
            onOpenTitleGuide={() => setIsTitleGuideOpen(true)}
            onCompleteMission={completeMission}
            onBuyReward={buyReward}
            showToast={showToast}
            openImage={setSelectedImage}
          />
        )}
        {route === "artworks" && <ArtworksPage artworks={artworks} openImage={setSelectedImage} />}
        {route === "image-search" && <ImageSearchPage openImage={setSelectedImage} />}
        {route === "collection" && <CollectionPage artworks={artworks} session={session} openImage={setSelectedImage} />}
        {route === "community" && <CommunityPage museums={museums} posts={posts} />}
        {route === "docent" && <AiDocentPage session={session} openImage={setSelectedImage} showToast={showToast} />}
        {route === "write" && <PostWritePage museums={museums} session={session} setPosts={setPosts} showToast={showToast} />}
        {postId && <PostDetailPage postId={postId} session={session} setPosts={setPosts} showToast={showToast} openImage={setSelectedImage} />}
        {route === "login" && <AuthPage />}
      </main>

      {selectedImage && <ImageModal art={selectedImage} onClose={() => setSelectedImage(null)} />}
      {isTitleGuideOpen && <TitleGuideModal points={earnedPoints} currentTitle={title} onClose={() => setIsTitleGuideOpen(false)} />}
      {toast && <div className="toast is-visible">{toast}</div>}
    </>
  );
}

function ApiNotice({ error, isLoading, onRetry }: { error: string; isLoading: boolean; onRetry: () => void }) {
  if (isLoading) {
    return (
      <section className="api-notice">
        <strong>데이터를 불러오는 중입니다.</strong>
        <span>작품, 미션, 게시판 정보를 백엔드에서 가져오고 있어요.</span>
      </section>
    );
  }

  return (
    <section className="api-notice is-error">
      <div>
        <strong>백엔드 API 연결에 실패했습니다.</strong>
        <span>서버가 응답하지 않습니다. 백엔드를 켠 뒤 다시 불러와주세요. 오류 코드: {error}</span>
      </div>
      <button onClick={onRetry}>다시 불러오기</button>
    </section>
  );
}

function ScanPage({
  artworks,
  daily,
  session,
  title,
  points,
  collectionCount,
  onOpenTitleGuide,
  onCompleteMission,
  onBuyReward,
  showToast,
  openImage,
}: {
  artworks: Artwork[];
  daily: DailyMissions | null;
  session: Session;
  title: string;
  points: number;
  collectionCount: number;
  onOpenTitleGuide: () => void;
  onCompleteMission: (artworkId: string) => Promise<void>;
  onBuyReward: (artworkId: string) => void;
  showToast: (message: string) => void;
  openImage: (art: Artwork) => void;
}) {
  const [challengeArt, setChallengeArt] = useState<Artwork | null>(null);
  const featured = artworks.filter((art) => !art.premium).slice(0, 6);
  const dailyMissions = daily?.missions ?? [];
  const weeklyRewards = weeklySelection(
    artworks.filter((art) => art.premium),
    4,
  );
  const completedMissionIds = new Set(
    session.state.missionCollection
      .filter((entry) => entry.dateKey === daily?.dateKey)
      .map((entry) => entry.artworkId),
  );
  const completedMissionCount = completedMissionIds.size;
  const heroArt = dailyMissions[0] ?? featured[0] ?? artworks[0] ?? null;
  const featuredResult = dailyMissions.find((art) => !completedMissionIds.has(art.id)) ?? dailyMissions[0] ?? featured[0] ?? null;

  function openMission(art: Artwork) {
    if (!session.user) {
      window.location.hash = "#login";
      showToast("로그인 후 미션에 도전할 수 있어요.");
      return;
    }
    setChallengeArt(art);
  }

  return (
    <section className="app-page is-active scan-curation-page">
      <ScanHero
        heroArt={heroArt}
        focusArt={featuredResult}
        title={title}
        points={points}
        collectionCount={collectionCount}
        completedMissionCount={completedMissionCount}
        onOpenTitleGuide={onOpenTitleGuide}
        onOpenMission={openMission}
        openImage={openImage}
      />

      <ScanUploadPanel
        dailyMissions={dailyMissions}
        completedMissionIds={completedMissionIds}
        completedMissionCount={completedMissionCount}
        openMission={openMission}
        openImage={openImage}
      />

      <FeaturedScanResult
        art={featuredResult}
        isCompleted={featuredResult ? completedMissionIds.has(featuredResult.id) : false}
        isLimitReached={completedMissionCount >= 3}
        onOpenMission={openMission}
        openImage={openImage}
      />

      <ScanResultCollectionGrid
        featured={featured}
        weeklyRewards={weeklyRewards}
        session={session}
        onBuyReward={onBuyReward}
        openImage={openImage}
      />

      {challengeArt && (
        <MissionChallengeModal
          art={challengeArt}
          onClose={() => setChallengeArt(null)}
          onComplete={async () => {
            await onCompleteMission(challengeArt.id);
            setChallengeArt(null);
          }}
        />
      )}
    </section>
  );
}

function ArtworksPage({
  artworks,
  openImage,
}: {
  artworks: Artwork[];
  openImage: (art: Artwork) => void;
}) {
  const [filter, setFilter] = useState("전체");
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const visible = artworks.filter((art) => isArtworkMatch(art, filter)).sort((left, right) => sortArtworks(left, right, sortMode));

  return (
    <section className="app-page is-active">
      <div className="page-title board-title">
        <div>
          <span className="eyebrow">ARTWORKS</span>
          <h1>미술작품 소개</h1>
        </div>
        <span className="count-pill">{visible.length}점</span>
      </div>

      <section className="catalog-section is-first">
        <div className="catalog-controls">
          <div className="filter-bar">
            {artworkFilters.map((item) => (
              <button key={item} className={`chip ${filter === item ? "is-active" : ""}`} onClick={() => setFilter(item)}>
                {item}
              </button>
            ))}
          </div>
          <div className="sort-control" aria-label="작품 정렬">
            <button className={sortMode === "name" ? "is-active" : ""} onClick={() => setSortMode("name")}>
              이름순
            </button>
            <button className={sortMode === "year" ? "is-active" : ""} onClick={() => setSortMode("year")}>
              연도순
            </button>
          </div>
        </div>
        <div className="catalog-grid">
          {visible.map((art) => (
            <ArtCard key={art.id} art={art} openImage={openImage} />
          ))}
        </div>
      </section>
    </section>
  );
}

function ImageSearchPage({ openImage }: { openImage: (art: Artwork) => void }) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [sharePreviewUrl, setSharePreviewUrl] = useState("");
  const [result, setResult] = useState<ImageSearchResponse | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState("");
  const [researchQuery, setResearchQuery] = useState("");
  const [researchResponse, setResearchResponse] = useState<ExternalSearchResponse | null>(null);
  const [researchError, setResearchError] = useState("");
  const [isResearching, setIsResearching] = useState(false);
  const [isSharingToBoard, setIsSharingToBoard] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bestMatch = result?.bestMatch ?? result?.matches[0] ?? null;

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setError("이미지 파일만 사용할 수 있습니다.");
      return;
    }

    setIsSearching(true);
    setError("");
    setResult(null);
    setResearchQuery("");
    setResearchResponse(null);
    setResearchError("");
    setIsResearching(false);
    setIsSharingToBoard(false);
    setSharePreviewUrl("");
    try {
      const imageDataUrl = await imageFileToMissionDataUrl(file);
      setPreviewUrl(imageDataUrl);
      setSharePreviewUrl(await imageDataUrlToSharePreviewDataUrl(imageDataUrl).catch(() => ""));
      const response = await api.searchSimilarImage(imageDataUrl);
      setResult(response);
      if (!response.bestMatch && !response.matches.length) {
        setError(response.indexedCount ? "비슷한 작품을 찾지 못했습니다." : "작품 이미지 임베딩이 아직 없습니다. 백필 스크립트를 먼저 실행해주세요.");
      }
    } catch (searchError) {
      const message = searchError instanceof Error ? searchError.message : "image_search_failed";
      setError(imageSearchErrorMessage(message));
    } finally {
      setIsSearching(false);
    }
  }

  async function loadArtworkResearch() {
    if (!bestMatch || isResearching) return;

    await fetchArtworkResearch(bestMatch.artwork);
  }

  async function fetchArtworkResearch(artwork: Artwork) {
    const query = artworkResearchQuery(artwork);
    setResearchQuery(query);
    setResearchResponse(null);
    setResearchError("");
    setIsResearching(true);
    try {
      const response = await api.externalSearch(query);
      setResearchResponse(response);
      return response;
    } catch (researchError) {
      setResearchError(researchError instanceof Error ? researchError.message : "external_search_failed");
      return null;
    } finally {
      setIsResearching(false);
    }
  }

  async function shareToBoard() {
    if (!bestMatch || isSharingToBoard) return;

    setIsSharingToBoard(true);
    try {
      const response = researchResponse ?? (await fetchArtworkResearch(bestMatch.artwork));
      const draft = imageSearchShareDraft({
        match: bestMatch,
        explanation: result?.explanation,
        sources: response?.results ?? [],
        sourceQuery: response?.query ?? artworkResearchQuery(bestMatch.artwork),
        uploadedImageDataUrl: sharePreviewUrl,
      });
      window.localStorage.setItem(IMAGE_SHARE_DRAFT_KEY, JSON.stringify(draft));
      window.location.hash = "#write";
    } catch {
      setError("업로드 사진을 포함한 공유 글을 준비하지 못했습니다. 사진을 조금 줄여 다시 시도해주세요.");
    } finally {
      setIsSharingToBoard(false);
    }
  }

  return (
    <section className="app-page image-search-page is-active">
      <div className="page-title board-title">
        <div>
          <span className="eyebrow">IMAGE SEARCH</span>
          <h1>사진과 닮은 작품 찾기</h1>
        </div>
        {result && <span className="count-pill">{result.indexedCount}/{result.artworkCount} indexed</span>}
      </div>

      <section className="image-search-panel">
        <div className="image-search-copy">
          <h2>사진 한 장으로 가장 가까운 작품을 찾습니다</h2>
          <p>현재 사이트 내에 있는 작품 기준으로 판단합니다.</p>
        </div>
        <div className="image-search-actions">
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isSearching}>
            {isSearching ? "검색 중" : "사진 선택"}
          </button>
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={handleFile} />
        </div>
        {previewUrl && (
          <figure className="image-search-preview">
            <img src={previewUrl} alt="검색에 사용한 사진" />
          </figure>
        )}
        {error && <p className="image-search-error">{error}</p>}
      </section>

      {bestMatch ? (
        <section className="catalog-section image-search-results">
          <div className="section-heading">
            <div>
              <span className="eyebrow">TOP MATCH</span>
              <h2>가장 가까운 작품</h2>
            </div>
            {result?.candidateCount ? <span className="count-pill">Top {result.candidateCount} 후보 비교</span> : null}
          </div>
          <div className="image-search-best">
            <div className="image-search-match">
              <span className="similarity-pill">CLIP 후보 {bestMatch.similarity.toFixed(3)}</span>
              <ArtCard art={bestMatch.artwork} openImage={openImage} />
            </div>
            <div className="image-search-explanation">
              <div className="image-search-explanation-header">
                <span className="eyebrow">AI COMMENT</span>
                <div className="image-search-badges">
                  {result && <span className={`rerank-pill ${result.reranked ? "is-on" : "is-off"}`}>{result.reranked ? "Vision 재랭킹" : "CLIP fallback"}</span>}
                  {result?.explanation && <span className="confidence-pill">{imageSearchConfidenceLabel(result.explanation.confidence)}</span>}
                </div>
              </div>
              <p className="image-search-summary">
                {result?.explanation?.summary ?? "비교 코멘트를 생성하는 중 문제가 발생했습니다."}
              </p>
              {result?.explanation?.similarParts.length ? (
                <div className="comparison-list">
                  <h3>비슷한 점</h3>
                  <ul>
                    {result.explanation.similarParts.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {result?.explanation?.differentParts.length ? (
                <div className="comparison-list">
                  <h3>다른 점</h3>
                  <ul>
                    {result.explanation.differentParts.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="image-search-research-actions">
                <button type="button" className="research-button" onClick={() => void loadArtworkResearch()} disabled={isResearching}>
                  {isResearching ? "자료 검색 중" : "작품 자료 찾기"}
                </button>
                <button type="button" className="share-board-button" onClick={() => void shareToBoard()} disabled={isSharingToBoard}>
                  {isSharingToBoard ? "공유 준비 중" : "게시판에 공유"}
                </button>
              </div>
            </div>
          </div>
          {(researchQuery || researchResponse || researchError || isResearching) && (
            <ArtworkResearchPanel query={researchQuery} response={researchResponse} isLoading={isResearching} error={researchError} />
          )}
        </section>
      ) : null}
    </section>
  );
}

function ArtworkResearchPanel({
  query,
  response,
  isLoading,
  error,
}: {
  query: string;
  response: ExternalSearchResponse | null;
  isLoading: boolean;
  error: string;
}) {
  const results = response?.results ?? [];

  return (
    <section className="artwork-research-panel" aria-live="polite">
      <div className="artwork-research-header">
        <div>
          <span className="eyebrow">MCP RESEARCH</span>
          <h3>작품 외부 자료</h3>
        </div>
        {query && <span>{query}</span>}
      </div>
      <div className="mcp-flow" aria-label="MCP 검색 흐름">
        <span>ArtCatch</span>
        <span>MCP tool</span>
        <span>External sources</span>
      </div>

      {isLoading ? <div className="external-search-state">MCP 검색 도구로 작품 자료를 찾고 있습니다.</div> : null}
      {!isLoading && error ? <div className="external-search-state">외부 자료를 불러오지 못했습니다.</div> : null}
      {!isLoading && response?.configured === false ? <div className="external-search-state">MCP 검색 서버 설정이 필요합니다.</div> : null}
      {!isLoading && response?.configured !== false && !error && response && !results.length ? (
        <div className="external-search-state">표시할 외부 자료가 없습니다.</div>
      ) : null}
      {results.length ? (
        <div className="external-search-list">
          {results.map((result) => {
            const snippet = result.snippet?.replace(/^Content:\s*/i, "");
            return (
              <a className="external-search-item" href={result.url} target="_blank" rel="noreferrer" key={result.url}>
                <div>
                  <strong>{result.title}</strong>
                  <span>{result.source}</span>
                </div>
                {snippet ? <p>{snippet}</p> : null}
              </a>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function MissionChallengeModal({
  art,
  onClose,
  onComplete,
}: {
  art: Artwork;
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [analysis, setAnalysis] = useState<MissionAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isLimitHelpOpen, setIsLimitHelpOpen] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const title = displayArtworkTitle(art);

  useEffect(() => {
    if (isCameraOpen && videoRef.current && cameraStreamRef.current) {
      videoRef.current.srcObject = cameraStreamRef.current;
      void videoRef.current.play().catch(() => setCameraError("카메라 영상을 시작하지 못했습니다. 브라우저 권한을 확인해주세요."));
    }
  }, [isCameraOpen]);

  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    };
  }, []);

  async function analyzeImage(imageDataUrl: string) {
    setPreviewUrl(imageDataUrl);
    setAnalysis(null);
    setIsAnalyzing(true);
    try {
      setAnalysis(await api.analyzeMission(art.id, imageDataUrl, "pose"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "ai_failed";
      setAnalysis({
        score: 0,
        passed: false,
        feedback: missionAnalysisErrorMessage(message),
      });
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await analyzeImage(await imageFileToMissionDataUrl(file));
    } catch {
      setAnalysis({
        score: 0,
        passed: false,
        feedback: "이미지를 불러오지 못했습니다. 다른 JPG나 PNG 사진으로 다시 시도해주세요.",
      });
    } finally {
      event.target.value = "";
    }
  }

  function openFilePicker() {
    if (isAnalyzing) return;
    setCameraError("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  }

  async function openCamera() {
    if (isAnalyzing) return;
    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("이 브라우저에서는 카메라 촬영을 지원하지 않습니다. 이미지 업로드를 사용해주세요.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      cameraStreamRef.current = stream;
      setIsCameraOpen(true);
    } catch {
      setCameraError("카메라 권한이 거부되었거나 사용할 수 없습니다. 브라우저 권한을 확인해주세요.");
    }
  }

  async function captureCameraFrame() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      setCameraError("카메라 영상이 아직 준비되지 않았습니다. 잠시 뒤 다시 눌러주세요.");
      return;
    }
    const imageDataUrl = videoFrameToDataUrl(video);
    closeCamera();
    await analyzeImage(imageDataUrl);
  }

  function closeCamera() {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    setIsCameraOpen(false);
  }

  async function complete() {
    if (!analysis?.passed) return;
    setIsSaving(true);
    try {
      await onComplete();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mission-modal">
      <button className="mission-modal-backdrop" onClick={onClose} aria-label="미션 닫기" />
      <section className="mission-modal-panel">
        <div className="mission-modal-header">
          <div>
            <span className="eyebrow">MISSION</span>
            <h2>{title}</h2>
          </div>
          <button className="ghost-button" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="mission-target">
          <img src={art.image || placeholder(art)} alt={title} />
          <p>
            작품의 색감, 구도, 분위기와 닮은 사진을 업로드하거나 카메라로 촬영해보세요.
          </p>
        </div>
        <p className="mission-mode-note">사람, 소품, 포즈로 작품의 장면을 자유롭게 따라해보세요.</p>
        <div className="mission-upload-actions">
          <button type="button" className="upload-action" onClick={openFilePicker} disabled={isAnalyzing}>
            이미지 업로드
          </button>
          <input ref={fileInputRef} className="mission-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFile} />
          <button type="button" className="upload-action" onClick={openCamera} disabled={isAnalyzing}>
            카메라로 촬영
          </button>
          <button
            type="button"
            className="mission-limit-help-button"
            aria-expanded={isLimitHelpOpen}
            aria-label="AI 판정 안내"
            onClick={() => setIsLimitHelpOpen((current) => !current)}
          >
            ?
          </button>
        </div>
        {isLimitHelpOpen && (
          <div className="mission-limit-help">
            <strong>AI 판정 안내</strong>
            <ul>
              <li>AI 유사도 비교 횟수 제한은 없어요.</li>
              <li>이미지는 최대 3MB까지 사용할 수 있어요.</li>
              <li>JPG, JPEG, PNG, WEBP만 지원하고 GIF는 지원하지 않아요.</li>
            </ul>
          </div>
        )}
        {cameraError && <p className="camera-error">{cameraError}</p>}
        {isCameraOpen && (
          <div className="camera-panel">
            <video ref={videoRef} playsInline muted />
            <div className="camera-actions">
              <button type="button" onClick={captureCameraFrame}>
                촬영하기
              </button>
              <button type="button" className="ghost-button" onClick={closeCamera}>
                취소
              </button>
            </div>
          </div>
        )}
        {previewUrl && (
          <div className="mission-preview">
            <img src={previewUrl} alt="업로드한 미션 사진" />
          </div>
        )}
        {isAnalyzing && <div className="mission-result">유사도를 분석하는 중입니다.</div>}
        {analysis && (
          <div className={`mission-result ${analysis.passed ? "is-pass" : "is-fail"}`}>
            <strong>유사도 {analysis.score}%</strong>
            <p>{analysis.feedback}</p>
            {analysis.coachTip && <p className="mission-coach-tip">{analysis.coachTip}</p>}
            {analysis.passed && (
              <button onClick={complete} disabled={isSaving}>
                {isSaving ? "수집 중" : "컬렉션에 수집"}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function CollectionPage({ artworks, session, openImage }: { artworks: Artwork[]; session: Session; openImage: (art: Artwork) => void }) {
  const [filter, setFilter] = useState("전체");
  const entries = [
    ...session.state.collection.map((entry) => ({ ...entry, source: "일반" })),
    ...session.state.missionCollection.map((entry) => ({ ...entry, source: "미션" })),
    ...session.state.purchases.map((artworkId) => ({ artworkId, source: "보상" })),
  ];
  const collectedIds = unique(entries.map((entry) => entry.artworkId));
  const collectedArtworks = collectedIds.flatMap((artworkId) => {
    const artwork = artworks.find((item) => item.id === artworkId);
    return artwork ? [artwork] : [];
  });
  const progress = collectionProgressFilters.map((filter) => {
    const count = collectedArtworks.filter((art) => isArtworkMatch(art, filter)).length;
    const target = artworks.filter((art) => !art.premium && isArtworkMatch(art, filter)).length;
    return { filter, target, count };
  });
  const pointShopTarget = artworks.filter((art) => art.premium).length;
  const pointShopProgress = {
    filter: "포인트샵 수집",
    target: pointShopTarget,
    count: session.state.purchases.length,
  };
  const allProgress = [...progress.filter((item) => item.target > 0), pointShopProgress].filter((item) => item.target > 0);
  const visibleEntries = entries.filter((entry) => {
    const art = artworks.find((item) => item.id === entry.artworkId);
    if (filter === "전체") return true;
    if (filter === "포인트샵 수집") return entry.source === "보상";
    return art ? isArtworkMatch(art, filter) : false;
  });

  return (
    <section className="app-page is-active">
      <div className="page-title">
        <span className="eyebrow">COLLECTION</span>
        <h1>컬렉션</h1>
      </div>
      <div className="collection-progress">
        {allProgress.map((item) => {
          const achieved = Math.min(item.count, item.target);
          return (
            <button
              key={item.filter}
              type="button"
              className={`collection-progress-item ${filter === item.filter ? "is-active" : ""}`}
              onClick={() => setFilter((current) => (current === item.filter ? "전체" : item.filter))}
            >
              <div>
                <strong>{item.filter}</strong>
                <span>
                  {achieved}/{item.target}
                </span>
              </div>
              <progress value={achieved} max={item.target} />
            </button>
          );
        })}
      </div>
      {entries.length ? (
        <div className="collection-filter-summary">
          <button type="button" className={filter === "전체" ? "is-active" : ""} onClick={() => setFilter("전체")}>
            전체 보기
          </button>
          <span>
            {filter === "전체" ? "수집한 전체 작품" : `${filter} 분류`} {visibleEntries.length}점
          </span>
        </div>
      ) : null}
      {entries.length ? (
        <>
          <div className="collection-grid">
            {visibleEntries.map((entry) => {
              const art = artworks.find((item) => item.id === entry.artworkId);
              return art ? <ArtCard key={`${entry.source}-${entry.artworkId}`} art={art} openImage={openImage} /> : null;
            })}
          </div>
          {!visibleEntries.length && <div className="board-empty">이 분류로 수집한 작품이 아직 없습니다.</div>}
        </>
      ) : (
        <div className="collection-empty">
          <div className="empty-art-mark">
            <span />
          </div>
          <strong>아직 수집한 작품이 없습니다.</strong>
          <p>오늘의 미션을 완료하거나 마음에 드는 작품을 컬렉션에 담아보세요.</p>
          <div className="empty-actions">
            <a className="primary-link" href="#artworks">
              작품 소개 보기
            </a>
            <a className="ghost-button" href="#scan">
              오늘 미션 보기
            </a>
          </div>
        </div>
      )}
    </section>
  );
}

function ExternalSearchPanel({
  query,
  response,
  isLoading,
  error,
}: {
  query: string;
  response: ExternalSearchResponse | null;
  isLoading: boolean;
  error: string;
}) {
  const results = response?.results ?? [];

  return (
    <section className="external-search-panel" aria-live="polite">
      <div className="external-search-header">
        <div>
          <span className="eyebrow">MCP SEARCH</span>
          <strong>외부 검색 결과</strong>
        </div>
        <span>{query}</span>
      </div>

      {isLoading ? <div className="external-search-state">외부 검색 중입니다.</div> : null}
      {!isLoading && error ? <div className="external-search-state">외부 검색 결과를 불러오지 못했습니다.</div> : null}
      {!isLoading && response?.configured === false ? (
        <div className="external-search-state">MCP 검색 서버 설정이 필요합니다.</div>
      ) : null}
      {!isLoading && response?.configured !== false && !error && response && !results.length ? (
        <div className="external-search-state">외부 검색 결과가 없습니다.</div>
      ) : null}
      {results.length ? (
        <div className="external-search-list">
          {results.map((result) => {
            const snippet = result.snippet?.replace(/^Content:\s*/i, "");
            return (
              <a className="external-search-item" href={result.url} target="_blank" rel="noreferrer" key={result.url}>
                <div>
                  <strong>{result.title}</strong>
                  <span>{result.source}</span>
                </div>
                {snippet ? <p>{snippet}</p> : null}
              </a>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function ScanHero({
  heroArt,
  focusArt,
  title,
  points,
  collectionCount,
  completedMissionCount,
  onOpenTitleGuide,
  onOpenMission,
  openImage,
}: {
  heroArt: Artwork | null;
  focusArt: Artwork | null;
  title: string;
  points: number;
  collectionCount: number;
  completedMissionCount: number;
  onOpenTitleGuide: () => void;
  onOpenMission: (art: Artwork) => void;
  openImage: (art: Artwork) => void;
}) {
  const heroStyle: CSSProperties | undefined = heroArt
    ? {
        backgroundImage: `linear-gradient(90deg, rgba(21, 17, 13, 0.82) 0%, rgba(21, 17, 13, 0.58) 48%, rgba(21, 17, 13, 0.18) 100%), url("${heroArt.image || placeholder(heroArt)}")`,
      }
    : undefined;

  return (
    <section className="scan-hero" style={heroStyle}>
      <div className="scan-hero-content">
        <span className="eyebrow">ARTCATCH CURATION</span>
        <h1>
          오늘의 작품을 수집하고
          <br />
          컬렉션으로 간직하세요
        </h1>
        <p>사진을 비교하고 닮은 작품을 전시처럼 탐색해보세요.</p>
        <div className="scan-hero-actions">
          <button disabled={!focusArt} onClick={() => focusArt && onOpenMission(focusArt)}>
            오늘의 스캔 시작
          </button>
          {heroArt && (
            <button className="ghost-button hero-ghost" onClick={() => openImage(heroArt)}>
              대표 작품 보기
            </button>
          )}
        </div>
      </div>
      <div className="scan-hero-status" aria-label="사용자 수집 상태">
        <button className="status-tile title-tile" type="button" onClick={onOpenTitleGuide}>
          <span className="label">칭호</span>
          <strong>{title}</strong>
        </button>
        <div className="status-tile">
          <span className="label">포인트</span>
          <strong>{points}P</strong>
        </div>
        <div className="status-tile">
          <span className="label">수집</span>
          <strong>{collectionCount}점</strong>
        </div>
        <div className="status-tile">
          <span className="label">오늘 완료</span>
          <strong>{completedMissionCount}/3</strong>
        </div>
      </div>
    </section>
  );
}

function ScanUploadPanel({
  dailyMissions,
  completedMissionIds,
  completedMissionCount,
  openMission,
  openImage,
}: {
  dailyMissions: Artwork[];
  completedMissionIds: Set<string>;
  completedMissionCount: number;
  openMission: (art: Artwork) => void;
  openImage: (art: Artwork) => void;
}) {
  const isLimitReached = completedMissionCount >= 3;

  return (
    <section className="scan-upload-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">SCAN UPLOAD</span>
          <h2>오늘의 미션 전시실</h2>
          <p className="section-note">작품을 선택하면 사진 업로드와 AI 유사도 비교가 이어져요.</p>
        </div>
        <span className="count-pill">완료 {completedMissionCount}/3</span>
      </div>
      <div className="mission-curation-grid">
        {dailyMissions.map((art) => {
          const isCompleted = completedMissionIds.has(art.id);
          return (
            <ArtCard
              key={art.id}
              art={art}
              openImage={openImage}
              action={
                <button disabled={isCompleted || isLimitReached} onClick={() => openMission(art)}>
                  {isCompleted ? "완료" : isLimitReached ? "오늘 완료" : "스캔 도전"}
                </button>
              }
            />
          );
        })}
      </div>
    </section>
  );
}

function FeaturedScanResult({
  art,
  isCompleted,
  isLimitReached,
  onOpenMission,
  openImage,
}: {
  art: Artwork | null;
  isCompleted: boolean;
  isLimitReached: boolean;
  onOpenMission: (art: Artwork) => void;
  openImage: (art: Artwork) => void;
}) {
  if (!art) return null;
  const title = displayArtworkTitle(art);

  return (
    <section className="featured-result">
      <button className="featured-result-image" onClick={() => openImage(art)} style={thumbStyle(art)} aria-label={`${title} 이미지 확대`}>
        <img
          src={art.image || placeholder(art)}
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = placeholder(art);
          }}
          alt={title}
        />
      </button>
      <div className="featured-result-copy">
        <span className="eyebrow">FEATURED RESULT</span>
        <h2>{title}</h2>
        <p>{formatArtworkMeta(art)}</p>
        <div className="featured-result-actions">
          <button disabled={isCompleted || isLimitReached} onClick={() => onOpenMission(art)}>
            {isCompleted ? "이미 완료한 작품" : isLimitReached ? "오늘 미션 완료" : "이 작품으로 스캔"}
          </button>
          <button className="ghost-button" onClick={() => openImage(art)}>
            작품 크게 보기
          </button>
        </div>
      </div>
    </section>
  );
}

function ScanResultCollectionGrid({
  featured,
  weeklyRewards,
  session,
  onBuyReward,
  openImage,
}: {
  featured: Artwork[];
  weeklyRewards: Artwork[];
  session: Session;
  onBuyReward: (artworkId: string) => void;
  openImage: (art: Artwork) => void;
}) {
  return (
    <>
      <section className="result-collection-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">COLLECTION</span>
            <h2>컬렉션</h2>
          </div>
          <a className="section-link simple-section-link" href="#artworks">
            전체 보기
          </a>
        </div>
        <div className="result-collection-grid">
          {featured.map((art) => (
            <ArtCard key={art.id} art={art} openImage={openImage} />
          ))}
        </div>
      </section>

      <section className="scan-point-shop-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">POINT SHOP</span>
            <h2>포인트 샵</h2>
            <p className="section-note">매주 월요일에 4개 작품이 새로 바뀌어요.</p>
          </div>
        </div>
        <div className="reward-grid">
          {weeklyRewards.map((art) => (
            <ArtCard
              key={art.id}
              art={art}
              openImage={openImage}
              action={
                <button disabled={session.state.purchases.includes(art.id) || session.state.points < art.cost} onClick={() => onBuyReward(art.id)}>
                  {session.state.purchases.includes(art.id) ? "설치완료" : `${art.cost}P 교환`}
                </button>
              }
            />
          ))}
        </div>
      </section>
    </>
  );
}

function CommunityPage({ museums, posts }: { museums: Museum[]; posts: Post[] }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState({ scope: "전체", country: "전체", area: "전체", museumId: "전체" });
  const [boardFilter, setBoardFilter] = useState<BoardFilter>("all");
  const [postPage, setPostPage] = useState(1);
  const [externalSearch, setExternalSearch] = useState<ExternalSearchResponse | null>(null);
  const [externalSearchError, setExternalSearchError] = useState("");
  const [isExternalSearching, setIsExternalSearching] = useState(false);
  const normalizedQuery = query.trim();
  const visibleMuseums = boardMuseums(museums);

  useEffect(() => {
    setPostPage(1);
  }, [normalizedQuery, boardFilter, search.scope, search.country, search.area, search.museumId]);

  useEffect(() => {
    if (normalizedQuery.length < 2) {
      setExternalSearch(null);
      setExternalSearchError("");
      setIsExternalSearching(false);
      return;
    }

    let canceled = false;
    setIsExternalSearching(true);
    setExternalSearchError("");

    const timer = window.setTimeout(() => {
      api
        .externalSearch(normalizedQuery)
        .then((response) => {
          if (!canceled) setExternalSearch(response);
        })
        .catch((error) => {
          if (!canceled) {
            setExternalSearch(null);
            setExternalSearchError(error instanceof Error ? error.message : "external_search_failed");
          }
        })
        .finally(() => {
          if (!canceled) setIsExternalSearching(false);
        });
    }, 350);

    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [normalizedQuery]);

  const filteredPosts = posts.filter((post) => {
    const visibleBody = parseImageSharePostBody(post.body).text;
    const text = `${post.title} ${visibleBody} ${boardMuseumName(post)}`.toLowerCase();
    const museum = visibleMuseums.find((item) => item.id === post.museumId);
    const museumMatch =
      (search.scope === "전체" || museum?.scope === search.scope) &&
      (search.country === "전체" || museum?.country === search.country) &&
      (search.area === "전체" || museum?.area === search.area) &&
      (search.museumId === "전체" || post.museumId === search.museumId);
    const boardMatch =
      boardFilter === "all" ||
      (boardFilter === "popular" ? post.upVotes >= 10 : (post.boardType ?? "free") === boardFilter);
    return boardMatch && museumMatch && (!normalizedQuery || text.includes(normalizedQuery.toLowerCase()));
  });
  const totalPostPages = Math.max(1, Math.ceil(filteredPosts.length / BOARD_POSTS_PER_PAGE));
  const currentPostPage = Math.min(postPage, totalPostPages);
  const pagedPosts = filteredPosts.slice(
    (currentPostPage - 1) * BOARD_POSTS_PER_PAGE,
    currentPostPage * BOARD_POSTS_PER_PAGE,
  );
  const visiblePageNumbers = pageNumbers(currentPostPage, totalPostPages);

  useEffect(() => {
    if (postPage > totalPostPages) setPostPage(totalPostPages);
  }, [postPage, totalPostPages]);

  return (
    <section className="app-page is-active board-page">
      <div className="page-title board-title">
        <div>
          <span className="eyebrow">BOARD</span>
          <h1>게시판</h1>
        </div>
        <a className="primary-link" href="#write">
          글쓰기
        </a>
      </div>

      <section className="board-shell">
        <div className="board-tabs">
          {boardTabs.map((tab) => (
            <button key={tab.id} className={boardFilter === tab.id ? "is-active" : ""} onClick={() => setBoardFilter(tab.id)}>
              {tab.label}
            </button>
          ))}
        </div>
        <div className="board-toolbar">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="게시글 검색" />
          <MuseumLocationPicker museums={visibleMuseums} value={search} onChange={setSearch} allowAll />
        </div>
        <div className="board-list">
          {filteredPosts.length ? (
            pagedPosts.map((post) => (
              <a className="board-row" key={post.id} href={`#post/${post.id}`}>
                <div className="board-row-main">
                  <div className="board-row-title">
                    <strong>{post.title}</strong>
                    <span>{boardTypeLabels[(post.boardType ?? "free") as BoardType]}</span>
                    {boardMuseumName(post) && <span>{boardMuseumName(post)}</span>}
                  </div>
                  <p>{parseImageSharePostBody(post.body).text}</p>
                  <div className="post-meta">
                    <span>{post.author}</span>
                    <span>{new Date(post.createdAt).toLocaleString("ko-KR")}</span>
                    <span>{post.museumCountry}</span>
                  </div>
                </div>
                <div className="board-counts">
                  <span>추천 {post.upVotes}</span>
                  <span>댓글 {post.commentCount}</span>
                </div>
              </a>
            ))
          ) : (
            <div className="board-empty">조건에 맞는 게시글이 없습니다.</div>
          )}
        </div>
        {filteredPosts.length ? (
          <div className="board-pagination" aria-label="게시글 페이지 이동">
            <span>
              총 {filteredPosts.length}개 중 {(currentPostPage - 1) * BOARD_POSTS_PER_PAGE + 1}-
              {Math.min(currentPostPage * BOARD_POSTS_PER_PAGE, filteredPosts.length)}개
            </span>
            <div>
              <button type="button" disabled={currentPostPage === 1} onClick={() => setPostPage((page) => Math.max(1, page - 1))}>
                이전
              </button>
              {visiblePageNumbers.map((page) => (
                <button
                  type="button"
                  key={page}
                  className={page === currentPostPage ? "is-active" : ""}
                  aria-current={page === currentPostPage ? "page" : undefined}
                  onClick={() => setPostPage(page)}
                >
                  {page}
                </button>
              ))}
              <button
                type="button"
                disabled={currentPostPage === totalPostPages}
                onClick={() => setPostPage((page) => Math.min(totalPostPages, page + 1))}
              >
                다음
              </button>
            </div>
          </div>
        ) : null}
        {normalizedQuery.length >= 2 ? (
          <ExternalSearchPanel
            query={normalizedQuery}
            response={externalSearch}
            isLoading={isExternalSearching}
            error={externalSearchError}
          />
        ) : null}
      </section>
    </section>
  );
}

function AiDocentPage({
  session,
  openImage,
  showToast,
}: {
  session: Session;
  openImage: (art: Artwork) => void;
  showToast: (message: string) => void;
}) {
  const [messages, setMessages] = useState<DocentChatMessage[]>([
    {
      id: "intro",
      role: "assistant",
      text: "궁금한 작품 분위기나 촬영하고 싶은 느낌을 말해보세요. 작품 데이터에서 관련 정보를 찾아 답할게요.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const chatRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const chat = chatRef.current;
    if (!chat) return;
    chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" });
  }, [messages, isAsking]);

  async function askDocent(messageText = input) {
    const message = messageText.trim();
    if (!message || isAsking) return;
    if (!session.user) {
      window.location.hash = "#login";
      showToast("로그인 후 AI 도우미에게 질문할 수 있어요.");
      return;
    }

    const userMessage: DocentChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      text: message,
    };
    setMessages((current) => [...current, userMessage]);
    setInput("");
    setIsAsking(true);

    try {
      const response = await api.askDocent(message);
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: response.answer,
          suggestedArtworks: response.suggestedArtworks,
          sources: response.sources,
        },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ai_docent_failed";
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: aiDocentErrorMessage(message),
        },
      ]);
    } finally {
      setIsAsking(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void askDocent();
  }

  return (
    <section className="app-page is-active docent-page">
      <div className="page-title board-title">
        <div>
          <span className="eyebrow">AI HELPER</span>
          <h1>AI 도우미</h1>
        </div>
      </div>

      <section className="docent-shell">
        <div className="docent-prompts">
          {docentQuickPrompts.map((prompt) => (
            <button key={prompt} type="button" className="chip" disabled={isAsking} onClick={() => void askDocent(prompt)}>
              {prompt}
            </button>
          ))}
        </div>

        <div ref={chatRef} className="docent-chat" aria-live="polite">
          {messages.map((message) => (
            <div key={message.id} className={`docent-message is-${message.role}`}>
              <p>{message.text}</p>
              {message.suggestedArtworks && message.suggestedArtworks.length > 0 && (
                <div className="docent-suggestions">
                  {message.suggestedArtworks.map((art) => (
                    <button key={art.id} type="button" className="docent-suggestion" onClick={() => openImage(art)}>
                      <img src={art.image || placeholder(art)} alt={displayArtworkTitle(art)} />
                      <span>
                        <strong>{displayArtworkTitle(art)}</strong>
                        <em>{art.artist}</em>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {isAsking && <div className="docent-loading">작품 지식을 찾는 중입니다.</div>}
        </div>

        <form className="docent-input" onSubmit={submit}>
          <input value={input} onChange={(event) => setInput(event.target.value)} maxLength={500} placeholder="작품, 분위기, 미션 아이디어를 물어보세요" />
          <button type="submit" disabled={isAsking || !input.trim()}>
            질문
          </button>
        </form>
      </section>
    </section>
  );
}

function ModerationPolicyGuide({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`moderation-policy-guide ${compact ? "is-compact" : ""}`}>
      <strong>AI 게시글 검수 안내</strong>
      <ul>
        <li>비하, 모욕, 위협, 혐오 표현이나 개인정보 노출 위험이 있으면 등록되지 않습니다.</li>
        <li>표현이 막히면 창은 그대로 유지되며, 문장을 수정한 뒤 다시 등록할 수 있습니다.</li>
        <li>작품과 감상에 대한 의견은 괜찮지만, 사람을 향한 공격 표현은 피해주세요.</li>
      </ul>
    </div>
  );
}

function ModerationPolicyModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="title-modal is-visible">
      <button className="title-modal-backdrop" type="button" onClick={onClose} aria-label="AI 댓글 검수 안내 닫기" />
      <section className="title-modal-panel">
        <div className="mission-modal-header">
          <div>
            <span className="eyebrow">AI CHECK</span>
            <h2>댓글 검수 안내</h2>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            닫기
          </button>
        </div>
        <ModerationPolicyGuide compact />
      </section>
    </div>
  );
}

function PostWritePage({
  museums,
  session,
  setPosts,
  showToast,
}: {
  museums: Museum[];
  session: Session;
  setPosts: (posts: Post[]) => void;
  showToast: (message: string) => void;
}) {
  const [draft, setDraft] = useState({ scope: "", country: "", area: "", museumId: "" });
  const [boardType, setBoardType] = useState<BoardType>("free");
  const [withoutMuseum, setWithoutMuseum] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const [shareMetadata, setShareMetadata] = useState<ImageShareMetadata | null>(null);
  const [isPolicyHelpOpen, setIsPolicyHelpOpen] = useState(false);
  const isSubmittingRef = useRef(false);
  const visibleMuseums = boardMuseums(museums);

  useEffect(() => {
    const rawDraft = window.localStorage.getItem(IMAGE_SHARE_DRAFT_KEY);
    if (!rawDraft) return;

    window.localStorage.removeItem(IMAGE_SHARE_DRAFT_KEY);
    try {
      const parsed = JSON.parse(rawDraft) as ImageShareDraft;
      setTitleDraft(parsed.title || "");
      setBodyDraft(parsed.body || "");
      setBoardType(parsed.boardType === "review" ? "review" : "free");
      setWithoutMuseum(Boolean(parsed.withoutMuseum));
      setShareMetadata(parsed.metadata ?? null);
    } catch {
      setShareMetadata(null);
    }
  }, []);

  useEffect(() => {
    if (withoutMuseum || !visibleMuseums.length || draft.museumId) return;
    const first = visibleMuseums[0];
    setDraft({ scope: first.scope, country: first.country, area: first.area, museumId: first.id });
  }, [visibleMuseums, draft.museumId, withoutMuseum]);

  async function createPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!session.user) {
      window.location.hash = "#login";
      showToast("로그인 후 작성할 수 있어요.");
      return;
    }
    if (!withoutMuseum && !draft.museumId) {
      showToast("미술관을 선택해주세요.");
      return;
    }
    if (isSubmittingRef.current) return;

    const submitButton = formElement.querySelector<HTMLButtonElement>('button[type="submit"]');
    const submitButtonText = submitButton?.textContent ?? "";
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "등록 중";
    }
    isSubmittingRef.current = true;
    const form = new FormData(formElement);
    const title = String(form.get("title")).trim();
    const body = String(form.get("body")).trim();
    const result = await api
      .createPost({
        title,
        body: appendImageShareMetadata(body, shareMetadata),
        museumId: withoutMuseum ? "__none__" : draft.museumId,
        boardType,
      })
      .catch(() => {
        isSubmittingRef.current = false;
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = submitButtonText;
        }
        showToast("게시글을 등록하지 못했습니다.");
        return null;
      });
    if (!result) return;
    setPosts(result.posts);
    if (isModerationBlocked(result.moderation)) {
      isSubmittingRef.current = false;
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = submitButtonText;
      }
      showToast(moderationNoticeMessage(result.moderation));
      return;
    }
    setShareMetadata(null);
    window.location.hash = "#community";
    showToast(moderationNoticeMessage(result.moderation) || "게시글을 등록했습니다.");
  }

  return (
    <section className="app-page is-active post-detail-page write-page">
      <a className="ghost-button back-link" href="#community">
        게시판으로
      </a>
      <form className="post-form write-form" onSubmit={createPost}>
        <div className="page-title board-title">
          <div>
            <span className="eyebrow">WRITE</span>
            <h1>글쓰기</h1>
          </div>
          <button
            type="button"
            className="policy-help-button"
            aria-label="AI 게시글 검수 안내"
            aria-expanded={isPolicyHelpOpen}
            onClick={() => setIsPolicyHelpOpen((current) => !current)}
          >
            ?
          </button>
        </div>
        {isPolicyHelpOpen && <ModerationPolicyGuide />}
        <div className="write-board-tabs">
          <button type="button" className={boardType === "free" ? "is-active" : ""} onClick={() => setBoardType("free")}>
            자유게시판
          </button>
          <button type="button" className={boardType === "review" ? "is-active" : ""} onClick={() => setBoardType("review")}>
            후기게시판
          </button>
        </div>
        {shareMetadata && (
          <div className="share-draft-notice">
            {shareMetadata.uploadedImage?.dataUrl && <img src={shareMetadata.uploadedImage.dataUrl} alt="게시글에 함께 공유될 업로드 사진" />}
            <span>
              <span className="eyebrow">IMAGE SEARCH SHARE</span>
              <strong>{displayArtworkTitle(shareMetadata.artwork)} 결과가 자동으로 채워졌습니다.</strong>
              <p>업로드한 사진도 게시글 상세에 함께 표시됩니다. 상단의 내 의견 부분만 더해도 등록할 수 있어요.</p>
            </span>
          </div>
        )}
        <input name="title" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} maxLength={36} placeholder="게시글 제목" required />
        <textarea
          name="body"
          value={bodyDraft}
          onChange={(event) => setBodyDraft(event.target.value)}
          maxLength={1200}
          rows={8}
          placeholder="미술관이나 작품에 대한 생각"
          required
        />
        <label className="write-option">
          <input
            type="checkbox"
            checked={withoutMuseum}
            onChange={(event) => {
              setWithoutMuseum(event.target.checked);
            }}
          />
          미술관 태그 없이 작성
        </label>
        {!withoutMuseum && <MuseumLocationPicker museums={visibleMuseums} value={draft} onChange={setDraft} />}
        <button type="submit">등록</button>
      </form>
    </section>
  );
}

function PostDetailPage({
  postId,
  session,
  setPosts,
  showToast,
  openImage,
}: {
  postId: string;
  session: Session;
  setPosts: (posts: Post[]) => void;
  showToast: (message: string) => void;
  openImage: (art: Artwork) => void;
}) {
  const [post, setPost] = useState<PostDetail | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [isEditPolicyHelpOpen, setIsEditPolicyHelpOpen] = useState(false);
  const [isCommentPolicyOpen, setIsCommentPolicyOpen] = useState(false);

  useEffect(() => {
    setPost(null);
    setIsEditing(false);
    void api.post(postId).then((result) => setPost(result.post));
  }, [postId]);

  async function vote(type: "up" | "down") {
    if (!session.user) {
      window.location.hash = "#login";
      showToast("로그인 후 추천할 수 있어요.");
      return;
    }
    try {
      const result = await api.votePost(postId, { type });
      setPost(result.post);
      const refreshed = await api.posts();
      setPosts(refreshed.posts);
    } catch (error) {
      showToast(error instanceof Error && error.message === "already_voted" ? "한 게시물에는 한 번만 추천하거나 비추천할 수 있어요." : "투표를 반영하지 못했어요.");
    }
  }

  async function submitComment(event: FormEvent<HTMLFormElement>, parentId?: string) {
    event.preventDefault();
    if (!session.user) {
      window.location.hash = "#login";
      showToast("로그인 후 댓글을 달 수 있어요.");
      return false;
    }
    const form = new FormData(event.currentTarget);
    const body = String(form.get("body")).trim();
    if (!body) return false;
    try {
      const result = await api.createComment(postId, { body, parentId });
      setPost(result.post);
      const moderationMessage = moderationNoticeMessage(result.moderation);
      if (moderationMessage) showToast(moderationMessage);
      if (isModerationBlocked(result.moderation)) return false;
      setReplyTo(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "login_required") {
        window.location.hash = "#login";
        showToast("로그인 후 댓글을 달 수 있어요.");
      } else {
        showToast("댓글을 등록하지 못했습니다.");
      }
      return false;
    }
  }

  async function deletePost() {
    if (!session.user || !post || session.user.nickname !== post.author) return;
    const confirmed = window.confirm("이 게시글을 삭제할까요?");
    if (!confirmed) return;

    try {
      const result = await api.deletePost(post.id);
      setPosts(result.posts);
      window.location.hash = "#community";
      showToast("게시글을 삭제했습니다.");
    } catch {
      showToast("게시글을 삭제하지 못했습니다.");
    }
  }

  async function deleteComment(commentId: string) {
    if (!session.user || !post) return;

    try {
      const result = await api.deleteComment(post.id, commentId);
      setPost(result.post);
      showToast("댓글을 삭제했습니다.");
    } catch {
      showToast("댓글을 삭제하지 못했습니다.");
    }
  }

  function startEditing() {
    if (!post) return;
    setEditTitle(post.title);
    setEditBody(parseImageSharePostBody(post.body).text);
    setIsEditing(true);
  }

  async function updatePost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session.user || !post || session.user.nickname !== post.author) return;

    const title = editTitle.trim();
    const body = editBody.trim();
    if (!title || !body) {
      showToast("제목과 내용을 입력해주세요.");
      return;
    }

    try {
      const result = await api.updatePost(post.id, { title, body });
      setPost(result.post);
      if (isModerationBlocked(result.moderation)) {
        showToast(moderationNoticeMessage(result.moderation));
        return;
      }
      setIsEditing(false);
      const refreshed = await api.posts();
      setPosts(refreshed.posts);
      showToast(moderationNoticeMessage(result.moderation) || "게시글을 수정했습니다.");
    } catch {
      showToast("게시글을 수정하지 못했습니다.");
    }
  }

  if (!post) {
    return (
      <section className="app-page is-active">
        <div className="collection-empty">게시글을 불러오는 중입니다.</div>
      </section>
    );
  }
  const parsedPostBody = parseImageSharePostBody(post.body);

  return (
    <section className="app-page is-active post-detail-page">
      <a className="ghost-button back-link" href="#community">
        게시판으로
      </a>
      <article className="post-detail">
        <div className="post-detail-top">
          <div className="post-detail-meta">
            <span className="board-badge">{boardTypeLabels[(post.boardType ?? "free") as BoardType]}게시판</span>
            {post.status && post.status !== "published" && <span className="board-badge is-held">검토 대기</span>}
            <span className="author-chip">
              {post.author}
              {post.authorTitle && <em>{post.authorTitle}</em>}
            </span>
            <span>{new Date(post.createdAt).toLocaleString("ko-KR")}</span>
            {boardMuseumName(post) && <span>{boardMuseumName(post)}</span>}
          </div>
          {session.user?.nickname === post.author && (
            <details className="post-action-menu">
              <summary aria-label="게시글 메뉴">...</summary>
              <div className="post-action-panel">
                <button type="button" onClick={startEditing}>
                  수정
                </button>
                <button type="button" className="is-danger" onClick={deletePost}>
                  삭제
                </button>
              </div>
            </details>
          )}
        </div>
        {isEditing ? (
          <form className="post-edit-form" onSubmit={updatePost}>
            <div className="form-assist-row">
              <span className="eyebrow">AI CHECK</span>
              <button
                type="button"
                className="policy-help-button"
                aria-label="AI 게시글 검수 안내"
                aria-expanded={isEditPolicyHelpOpen}
                onClick={() => setIsEditPolicyHelpOpen((current) => !current)}
              >
                ?
              </button>
            </div>
            {isEditPolicyHelpOpen && <ModerationPolicyGuide compact />}
            <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={36} required />
            <textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} maxLength={1200} rows={6} required />
            <div className="post-edit-actions">
              <button type="button" className="ghost-button" onClick={() => setIsEditing(false)}>
                취소
              </button>
              <button type="submit">저장</button>
            </div>
          </form>
        ) : (
          <>
            <h1>{post.title}</h1>
            <p>{parsedPostBody.text}</p>
            {parsedPostBody.metadata && <SharedImageSearchAttachment metadata={parsedPostBody.metadata} openImage={openImage} />}
            <div className="vote-row">
              <button onClick={() => vote("up")}>추천 {post.upVotes}</button>
              <button className="ghost-button" onClick={() => vote("down")}>
                비추천 {post.downVotes}
              </button>
            </div>
          </>
        )}
      </article>

      <section className="comments-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">COMMENTS</span>
            <h2>댓글 {post.commentCount}</h2>
          </div>
          <button
            type="button"
            className="policy-help-button"
            aria-label="AI 댓글 검수 안내"
            aria-expanded={isCommentPolicyOpen}
            onClick={() => setIsCommentPolicyOpen(true)}
          >
            ?
          </button>
        </div>
        <CommentForm onSubmit={(event) => submitComment(event)} placeholder="댓글을 남겨보세요" />
        <div className="comment-list">
          {post.comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              session={session}
              replyTo={replyTo}
              setReplyTo={setReplyTo}
              submitComment={submitComment}
              deleteComment={deleteComment}
            />
          ))}
        </div>
      </section>
      {isCommentPolicyOpen && <ModerationPolicyModal onClose={() => setIsCommentPolicyOpen(false)} />}
    </section>
  );
}

function SharedImageSearchAttachment({ metadata, openImage }: { metadata: ImageShareMetadata; openImage: (art: Artwork) => void }) {
  const art = metadata.artwork;
  const sources = metadata.sources ?? [];
  const uploadedImage = metadata.uploadedImage;

  return (
    <section className="shared-image-attachment">
      <div className="shared-image-header">
        <div>
          <span className="eyebrow">IMAGE SEARCH RESULT</span>
          <h2>매칭된 작품</h2>
        </div>
        <span>CLIP {metadata.similarity.toFixed(3)}</span>
      </div>
      <div className="shared-image-body">
        <div className={`shared-image-comparison ${uploadedImage?.dataUrl ? "" : "is-single"}`}>
          {uploadedImage?.dataUrl && (
            <figure className="shared-upload-card">
              <img src={uploadedImage.dataUrl} alt={uploadedImage.caption || "이미지 검색에 업로드한 사진"} />
              <figcaption>
                <strong>업로드한 사진</strong>
                <em>이미지 검색에 사용한 사진</em>
              </figcaption>
            </figure>
          )}
          <button className="shared-artwork-card" type="button" onClick={() => openImage(art)}>
            <img
              src={art.image || placeholder(art)}
              alt={displayArtworkTitle(art)}
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = placeholder(art);
              }}
            />
            <span>
              <strong>{displayArtworkTitle(art)}</strong>
              <em>
                {art.artist} · {art.year}
              </em>
            </span>
          </button>
        </div>
        <div className="shared-image-notes">
          {metadata.explanation?.summary && <p>{metadata.explanation.summary}</p>}
          {metadata.explanation?.similarParts?.length ? (
            <div>
              <strong>비슷한 점</strong>
              <ul>
                {metadata.explanation.similarParts.slice(0, 3).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
      <div className="shared-source-section">
        <div className="shared-source-header">
          <span className="eyebrow">MCP SOURCES</span>
          <span>{metadata.sourceQuery}</span>
        </div>
        {sources.length ? (
          <div className="shared-source-list">
            {sources.map((source) => (
              <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>
                <strong>{source.title}</strong>
                <span>{source.source}</span>
              </a>
            ))}
          </div>
        ) : (
          <p className="shared-source-empty">공유 시점에 저장된 MCP 출처 링크가 없습니다.</p>
        )}
      </div>
    </section>
  );
}

function CommentItem({
  comment,
  session,
  replyTo,
  setReplyTo,
  submitComment,
  deleteComment,
  depth = 0,
}: {
  comment: PostComment;
  session: Session;
  replyTo: string | null;
  setReplyTo: (id: string | null) => void;
  submitComment: (event: FormEvent<HTMLFormElement>, parentId?: string) => boolean | void | Promise<boolean | void>;
  deleteComment: (commentId: string) => Promise<void>;
  depth?: number;
}) {
  const isDeleted = comment.body === deletedCommentBody;
  const canDelete = !isDeleted && session.user?.nickname === comment.author;
  const displayDepth = Math.min(depth, 2);

  return (
    <div className={`comment-item ${depth > 0 ? "is-reply" : ""} ${isDeleted ? "is-deleted" : ""}`} data-depth={displayDepth}>
      <div className="comment-body">
        <div className="post-meta">
          <span className="author-chip is-compact">
            {comment.author}
            {comment.authorTitle && <em>{comment.authorTitle}</em>}
          </span>
          <span>{new Date(comment.createdAt).toLocaleString("ko-KR")}</span>
        </div>
        <p>{comment.body}</p>
        <div className="comment-actions">
          {!isDeleted && (
            <button className="comment-action-button" onClick={() => setReplyTo(replyTo === comment.id ? null : comment.id)}>
              {replyTo === comment.id ? "취소" : "답글"}
            </button>
          )}
          {canDelete && (
            <button className="comment-action-button is-danger" onClick={() => void deleteComment(comment.id)}>
              삭제
            </button>
          )}
        </div>
      </div>
      {replyTo === comment.id && (
        <div className="comment-reply-form">
          <CommentForm onSubmit={(event) => submitComment(event, comment.id)} placeholder="답글을 남겨보세요" />
        </div>
      )}
      {comment.replies.length > 0 && (
        <div className="reply-list" data-depth={Math.min(depth + 1, 2)}>
          {comment.replies.map((reply) => (
            <CommentItem
              key={reply.id}
              comment={reply}
              session={session}
              replyTo={replyTo}
              setReplyTo={setReplyTo}
              submitComment={submitComment}
              deleteComment={deleteComment}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CommentForm({ onSubmit, placeholder }: { onSubmit: (event: FormEvent<HTMLFormElement>) => boolean | void | Promise<boolean | void>; placeholder: string }) {
  const [body, setBody] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    const shouldReset = await onSubmit(event);
    if (shouldReset !== false) setBody("");
  }

  return (
    <form className="comment-form" onSubmit={submit}>
      <input name="body" value={body} onChange={(event) => setBody(event.target.value)} maxLength={240} placeholder={placeholder} required />
      <button type="submit">등록</button>
    </form>
  );
}

function MuseumLocationPicker({
  museums,
  value,
  onChange,
  allowAll = false,
}: {
  museums: Museum[];
  value: { scope: string; country: string; area: string; museumId: string };
  onChange: (next: { scope: string; country: string; area: string; museumId: string }) => void;
  allowAll?: boolean;
}) {
  const allLabel = "전체";
  const scopes = unique(museums.map((museum) => museum.scope));
  const scoped = museums.filter((museum) => allowAll && value.scope === allLabel ? true : museum.scope === value.scope);
  const countries = unique(scoped.map((museum) => museum.country));
  const countryFiltered = scoped.filter((museum) => allowAll && value.country === allLabel ? true : museum.country === value.country);
  const areas = unique(countryFiltered.map((museum) => museum.area));
  const areaFiltered = countryFiltered.filter((museum) => allowAll && value.area === allLabel ? true : museum.area === value.area);

  function firstMuseum(nextMuseums: Museum[]) {
    return allowAll ? allLabel : nextMuseums[0]?.id ?? "";
  }

  return (
    <div className="museum-picker">
      <select
        value={value.scope || (allowAll ? allLabel : scopes[0] ?? "")}
        onChange={(event) => {
          const scope = event.target.value;
          const nextScoped = museums.filter((museum) => allowAll && scope === allLabel ? true : museum.scope === scope);
          const country = allowAll ? allLabel : nextScoped[0]?.country ?? "";
          const area = allowAll ? allLabel : nextScoped.find((museum) => museum.country === country)?.area ?? "";
          const nextMuseums = nextScoped.filter((museum) => (allowAll || museum.country === country) && (allowAll || museum.area === area));
          onChange({ scope, country, area, museumId: firstMuseum(nextMuseums) });
        }}
      >
        {allowAll && <option value={allLabel}>전체 구분</option>}
        {scopes.map((scope) => (
          <option key={scope} value={scope}>
            {scope}
          </option>
        ))}
      </select>
      <select
        value={value.country || (allowAll ? allLabel : countries[0] ?? "")}
        onChange={(event) => {
          const country = event.target.value;
          const nextAreas = unique(scoped.filter((museum) => allowAll && country === allLabel ? true : museum.country === country).map((museum) => museum.area));
          const area = allowAll ? allLabel : nextAreas[0] ?? "";
          const nextMuseums = scoped.filter((museum) => (allowAll && country === allLabel ? true : museum.country === country) && (allowAll || museum.area === area));
          onChange({ ...value, country, area, museumId: firstMuseum(nextMuseums) });
        }}
      >
        {allowAll && <option value={allLabel}>전체 나라</option>}
        {countries.map((country) => (
          <option key={country} value={country}>
            {country}
          </option>
        ))}
      </select>
      <select
        value={value.area || (allowAll ? allLabel : areas[0] ?? "")}
        onChange={(event) => {
          const area = event.target.value;
          const nextMuseums = countryFiltered.filter((museum) => allowAll && area === allLabel ? true : museum.area === area);
          onChange({ ...value, area, museumId: firstMuseum(nextMuseums) });
        }}
      >
        {allowAll && <option value={allLabel}>전체 지역</option>}
        {areas.map((area) => (
          <option key={area} value={area}>
            {area}
          </option>
        ))}
      </select>
      <select value={value.museumId || (allowAll ? allLabel : areaFiltered[0]?.id ?? "")} onChange={(event) => onChange({ ...value, museumId: event.target.value })}>
        {allowAll && <option value={allLabel}>전체 미술관</option>}
        {areaFiltered.map((museum) => (
          <option key={museum.id} value={museum.id}>
            {museum.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function AuthPage() {
  const [googleStatus, setGoogleStatus] = useState<{ configured: boolean; callbackUrl: string } | null>(null);

  useEffect(() => {
    void api.googleStatus().then(setGoogleStatus).catch(() => setGoogleStatus({ configured: false, callbackUrl: "" }));
  }, []);

  const googleReady = googleStatus?.configured ?? false;

  return (
    <section className="app-page auth-page is-active">
      <div className="auth-card">
        <div className="page-title">
          <span className="eyebrow">LOGIN</span>
          <h1>Google 로그인</h1>
        </div>
        <div className="auth-form">
          {googleReady ? (
            <a className="primary-link google-login-link" href={api.googleLoginUrl()}>
              Google 계정으로 계속하기
            </a>
          ) : (
            <button className="primary-link google-login-link" type="button" disabled>
              Google 설정 필요
            </button>
          )}
        </div>
        <p className="auth-switch">
          {googleReady
            ? "로그인하면 서버 세션으로 ArtCatch 계정이 연결됩니다."
            : "backend/.env에 GOOGLE_CLIENT_ID와 GOOGLE_CLIENT_SECRET을 설정해주세요."}
        </p>
        {!googleReady && googleStatus?.callbackUrl && (
          <p className="auth-switch callback-url">
            Redirect URI: {googleStatus.callbackUrl}
          </p>
        )}
      </div>
    </section>
  );
}

function ArtCard({
  art,
  action,
  openImage,
}: {
  art: Artwork;
  action?: ReactNode;
  openImage: (art: Artwork) => void;
}) {
  const title = displayArtworkTitle(art);
  return (
    <article className="art-card">
      <figure className="art-thumb" style={thumbStyle(art)}>
        <button className="art-image-button" onClick={() => openImage(art)} aria-label={`${title} 이미지 확대`}>
          <img
            src={art.image || placeholder(art)}
            onError={(event) => {
              event.currentTarget.onerror = null;
              event.currentTarget.src = placeholder(art);
            }}
            alt={title}
            loading="lazy"
          />
        </button>
        <figcaption>
          {art.artist} · {translateArtworkText(art.year)}
        </figcaption>
      </figure>
      <div className="art-body">
        <div className="art-title-row">
          <h3>{title}</h3>
          {art.premium && <span className="cost-pill">{art.cost}P</span>}
        </div>
        <div className="art-meta">
          {formatArtworkMeta(art)}
        </div>
        <div className="art-tags">
          {displayArtworkTags(art).map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
        {action && <div className="card-actions">{action}</div>}
      </div>
    </article>
  );
}

function ImageModal({ art, onClose }: { art: Artwork; onClose: () => void }) {
  const title = displayArtworkTitle(art);
  return (
    <div className="image-modal is-visible">
      <div className="image-modal-backdrop" onClick={onClose} />
      <div className="image-modal-panel">
        <button className="modal-close" onClick={onClose} aria-label="닫기">
          ×
        </button>
        <img
          src={art.image || placeholder(art)}
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = placeholder(art);
          }}
          alt={title}
        />
        <div>
          <h2>{title}</h2>
          <p>
            {art.artist} · {translateArtworkText(art.year)} · {translateArtworkText(art.period)}
          </p>
        </div>
      </div>
    </div>
  );
}

function TitleGuideModal({ points, currentTitle, onClose }: { points: number; currentTitle: string; onClose: () => void }) {
  return (
    <div className="title-modal is-visible">
      <button className="title-modal-backdrop" onClick={onClose} aria-label="칭호 안내 닫기" />
      <section className="title-modal-panel">
        <div className="mission-modal-header">
          <div>
            <span className="eyebrow">TITLE</span>
            <h2>칭호 안내</h2>
          </div>
          <button className="ghost-button" onClick={onClose}>
            닫기
          </button>
        </div>
        <p className="title-guide-summary">
          현재 칭호는 <strong>{currentTitle}</strong>이고, 누적 획득 포인트는 <strong>{points}P</strong>입니다.
        </p>
        <div className="title-guide-list">
          {titleSteps.map(([minPoints, title]) => {
            const unlocked = points >= minPoints;
            return (
              <div key={title} className={`title-guide-item ${unlocked ? "is-unlocked" : ""}`}>
                <div>
                  <strong>{title}</strong>
                  <span>{minPoints}P 이상</span>
                </div>
                <em>{unlocked ? "해금됨" : `${minPoints - points}P 남음`}</em>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function isArtworkMatch(art: Artwork, filter: string) {
  if (filter === "전체") return true;
  const values = [art.origin, art.period, ...art.category, ...art.tags].flatMap((value) => [value, translateArtworkText(value)]);
  return values.includes(filter);
}

function formatArtworkMeta(art: Artwork) {
  return [art.origin, translateArtworkText(art.period), translateArtworkText(art.region)].filter(Boolean).join(" · ");
}

function displayArtworkTitle(art: Artwork) {
  return art.title;
}

function displayArtworkTags(art: Artwork) {
  const importedArtwork = art.id.startsWith("aic-") || art.id.startsWith("cma-");
  const translatedCategories = art.category.map(translateArtworkText);
  return unique(art.tags.map(translateArtworkText))
    .filter((tag) => tag !== art.origin)
    .filter((tag) => !importedArtwork || !translatedCategories.includes(tag))
    .slice(0, 4);
}

function imageSearchErrorMessage(message: string) {
  if (message.includes("clip_transformers_unavailable")) return "백엔드에 로컬 CLIP 패키지가 설치되지 않았습니다.";
  if (message.includes("clip_embedding_dimensions")) return "CLIP 모델의 벡터 차원이 DB 설정과 맞지 않습니다.";
  if (message.includes("image_too_large")) return "이미지는 최대 3MB 정도로 줄여서 다시 시도해주세요.";
  if (message.includes("image_invalid_type")) return "JPG, PNG, WEBP 이미지만 사용할 수 있습니다.";
  if (message.includes("artwork_image_download_failed")) return "외부 작품 이미지를 가져오지 못했습니다.";
  return `이미지 검색에 실패했습니다. ${message}`;
}

function imageSearchConfidenceLabel(confidence: "high" | "medium" | "low") {
  if (confidence === "high") return "판단 강함";
  if (confidence === "low") return "판단 약함";
  return "판단 보통";
}

function artworkResearchQuery(art: Artwork) {
  return [displayArtworkTitle(art), art.artist, "official museum collection artwork analysis"].filter(Boolean).join(" ");
}

function imageSearchShareDraft({
  match,
  explanation,
  sources,
  sourceQuery,
  uploadedImageDataUrl,
}: {
  match: ImageSearchMatch;
  explanation: ImageSearchResponse["explanation"];
  sources: ExternalSearchResult[];
  sourceQuery: string;
  uploadedImageDataUrl?: string;
}): ImageShareDraft {
  const title = truncateText(`내 사진이 ${displayArtworkTitle(match.artwork)}랑 닮았나요?`, 36);
  const metadata: ImageShareMetadata = {
    kind: "image-search-share",
    artwork: match.artwork,
    similarity: match.similarity,
    explanation,
    sources: sources.slice(0, 5),
    sourceQuery,
    uploadedImage: uploadedImageDataUrl
      ? {
          dataUrl: uploadedImageDataUrl,
          caption: "사용자가 이미지 검색에 업로드한 사진",
        }
      : undefined,
  };
  return {
    title,
    body: imageSearchShareBody(match, explanation),
    boardType: "review",
    withoutMuseum: true,
    metadata,
  };
}

function imageSearchShareBody(match: ImageSearchMatch, explanation: ImageSearchResponse["explanation"]) {
  const similar = explanation?.similarParts?.slice(0, 2).join(" / ") || "AI가 색감, 구도, 분위기를 기준으로 비슷한 부분을 찾았습니다.";
  const different = explanation?.differentParts?.slice(0, 2).join(" / ") || "세부 피사체나 배경은 다를 수 있습니다.";
  return [
    "내 의견: ",
    "",
    `${displayArtworkTitle(match.artwork)} 매칭 결과를 공유합니다.`,
    explanation?.summary ? `AI 요약: ${explanation.summary}` : "",
    `비슷한 점: ${similar}`,
    `다른 점: ${different}`,
    "",
    "MCP 외부 자료는 게시글 상세에서 확인할 수 있어요.",
  ]
    .filter((line, index) => index < 2 || line)
    .join("\n");
}

function appendImageShareMetadata(body: string, metadata: ImageShareMetadata | null) {
  if (!metadata) return body;
  return `${body.trim()}\n\n${IMAGE_SHARE_MARKER_PREFIX}${encodeShareMetadata(metadata)}${IMAGE_SHARE_MARKER_SUFFIX}`;
}

function parseImageSharePostBody(body: string) {
  const start = body.lastIndexOf(IMAGE_SHARE_MARKER_PREFIX);
  if (start < 0) return { text: body, metadata: null as ImageShareMetadata | null };
  const end = body.indexOf(IMAGE_SHARE_MARKER_SUFFIX, start + IMAGE_SHARE_MARKER_PREFIX.length);
  if (end < 0) return { text: body, metadata: null as ImageShareMetadata | null };

  const encoded = body.slice(start + IMAGE_SHARE_MARKER_PREFIX.length, end);
  const text = body.slice(0, start).trim();
  try {
    const metadata = JSON.parse(decodeShareMetadata(encoded)) as ImageShareMetadata;
    if (metadata?.kind !== "image-search-share" || !metadata.artwork?.id) throw new Error("invalid_share_metadata");
    return { text, metadata };
  } catch {
    return { text: body, metadata: null as ImageShareMetadata | null };
  }
}

function encodeShareMetadata(metadata: ImageShareMetadata) {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function decodeShareMetadata(value: string) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

function translateArtworkText(value: string) {
  const text = value.trim();
  if (!text) return text;

  const direct = artworkTextTranslations[text.toLowerCase()];
  if (direct) return direct;

  const inferred = inferArtworkMediumText(text);
  if (inferred) return inferred;

  return artworkTextReplacements.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

function inferArtworkMediumText(value: string) {
  const text = value.toLowerCase();
  if (text.includes("oil on canvas")) return "캔버스에 유채";
  if (text.includes("oil on wood") || text.includes("oil on panel")) return "목판에 유채";
  if (text.includes("oil on fabric")) return "천에 유채";
  if (text.includes("oil on")) return "유채";
  if (text.includes("pastel")) return "파스텔";
  if (text.includes("woodblock")) return "목판화";
  if (text.includes("engraving")) return "동판화";
  if (text.includes("etching")) return "에칭";
  if (text.includes("lithograph")) return "석판화";
  if (text.includes("marble")) return "대리석";
  if (text.includes("bronze")) return "청동";
  if (text.includes("terracotta")) return "테라코타";
  if (text.includes("ceramic") || text.includes("porcelain")) return "도자";
  if (text.includes("ink") && text.includes("paper")) return "종이에 먹";
  if (text.includes("mixed media")) return "혼합 매체";
  if (text.includes("fabric") || text.includes("textile")) return "섬유";
  return "";
}

function sortArtworks(left: Artwork, right: Artwork, mode: SortMode) {
  const leftTitle = displayArtworkTitle(left);
  const rightTitle = displayArtworkTitle(right);
  if (mode === "year") return startYear(left.year) - startYear(right.year) || leftTitle.localeCompare(rightTitle, "ko-KR");
  return leftTitle.localeCompare(rightTitle, "ko-KR") || startYear(left.year) - startYear(right.year);
}

function startYear(year: string) {
  if (year.includes("기원전")) return -Number(year.match(/\d+/)?.[0] ?? 0);
  if (year.includes("세기")) return Number(year.match(/\d+/)?.[0] ?? 1) * 100 - 50;
  return Number(year.match(/\d+/)?.[0] ?? 9999);
}

function weeklySelection<T>(items: T[], count: number) {
  if (items.length <= count) return items;
  const now = new Date();
  const weekKey = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / (7 * 24 * 60 * 60 * 1000));
  const start = weekKey % items.length;
  return Array.from({ length: count }, (_, index) => items[(start + index) % items.length]);
}

function missionAnalysisErrorMessage(message: string) {
  if (message === "openai_api_key_required") {
    return "AI 판정을 쓰려면 백엔드 .env에 OPENAI_API_KEY를 먼저 설정해주세요.";
  }
  if (message === "mission_image_too_large") {
    return "이미지가 너무 커요. 더 작은 사진으로 다시 시도해주세요.";
  }
  if (message === "mission_image_invalid_type" || message === "mission_image_invalid" || message.includes("valid image")) {
    return "이미지 파일을 읽지 못했습니다. JPG, PNG, WEBP 사진으로 다시 시도해주세요.";
  }
  if (message === "openai_timeout") {
    return "AI 판정 시간이 너무 오래 걸렸어요. 잠시 후 다시 시도해주세요.";
  }
  return `AI 유사도 판정에 실패했습니다. ${message}`;
}

function aiDocentErrorMessage(message: string) {
  if (message === "openai_api_key_required") {
    return "AI 도우미를 쓰려면 백엔드 .env에 OPENAI_API_KEY를 먼저 설정해주세요.";
  }
  if (message === "openai_timeout") {
    return "AI 도우미 답변 시간이 너무 오래 걸렸어요. 잠시 후 다시 시도해주세요.";
  }
  if (message === "login_required") {
    return "로그인 후 AI 도우미에게 질문할 수 있어요.";
  }
  return `AI 도우미가 답변하지 못했습니다. ${message}`;
}

async function imageFileToMissionDataUrl(file: File) {
  if (!file.type.startsWith("image/")) return readFileAsDataUrl(file);

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    return imageToMissionDataUrl(image);
  } catch {
    return readFileAsDataUrl(file);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function imageDataUrlToSharePreviewDataUrl(dataUrl: string) {
  const image = await loadImage(dataUrl);
  let maxSize = IMAGE_SHARE_PREVIEW_MAX_SIZE;
  let quality = 0.72;
  let output = imageToSizedJpegDataUrl(image, maxSize, quality);

  for (let attempt = 0; attempt < 5 && output.length > IMAGE_SHARE_PREVIEW_MAX_CHARS; attempt += 1) {
    maxSize = Math.max(240, Math.round(maxSize * 0.82));
    quality = Math.max(0.5, quality - 0.08);
    output = imageToSizedJpegDataUrl(image, maxSize, quality);
  }

  return output;
}

function videoFrameToDataUrl(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  const maxSize = 1280;
  const scale = Math.min(1, maxSize / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas_unavailable");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

function imageToMissionDataUrl(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  const maxSize = 1280;
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas_unavailable");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

function imageToSizedJpegDataUrl(image: HTMLImageElement, maxSize: number, quality: number) {
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas_unavailable");
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function thumbStyle(art: Artwork) {
  return {
    "--thumb-a": rgb(art.palette),
    "--thumb-b": rgb(secondColor(art.palette)),
  } as CSSProperties;
}

function rgb(color: number[]) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function secondColor(color: number[]) {
  return [
    Math.min(255, Math.round(color[0] * 0.65 + 92)),
    Math.min(255, Math.round(color[1] * 0.65 + 72)),
    Math.min(255, Math.round(color[2] * 0.65 + 62)),
  ];
}

function placeholder(art: Artwork) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="660"><rect width="900" height="660" fill="${rgb(art.palette)}"/><text x="70" y="120" font-size="44" fill="white" font-family="Arial">${escapeXml(displayArtworkTitle(art))}</text><text x="70" y="180" font-size="28" fill="white" font-family="Arial">${escapeXml(art.artist)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
