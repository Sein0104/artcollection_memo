const SESSION_KEY = "artcatch-session-v2";
const OLD_STORAGE_KEY = "artcatch-state-v1";

const FILTERS = [
  "전체",
  "서양",
  "동양",
  "한국화",
  "인상주의",
  "추상",
  "초상",
  "풍경",
  "수묵",
  "현대",
];
const MUSEUM_SCOPES = ["전체", "국내", "해외"];
const COLLECTION_TABS = ["전체", "일반", "미션", "보상"];
const TITLE_STEPS = [
  [360, "명예 수집가"],
  [220, "큐레이터 후보"],
  [120, "갤러리 산책자"],
  [0, "새내기 감상가"],
];

let ARTWORKS = [];
let MUSEUMS = [];
let POSTS = [];
let state = emptyState();
let activeFilter = "전체";
let collectionTab = "전체";
let museumScope = "전체";
let museumTag = "전체";
let activeMuseumId = "전체";
let boardSearchOpen = false;
let boardSearchQuery = "";
let boardSearchMuseumId = "전체";
let latestScan = null;
let lazyObserver = null;

const $ = (selector) => document.querySelector(selector);
const nonPremiumArtworks = () => ARTWORKS.filter((art) => !art.premium);
const premiumArtworks = () => ARTWORKS.filter((art) => art.premium);
const byId = (id) => ARTWORKS.find((art) => art.id === id);
const museumById = (id) => MUSEUMS.find((museum) => museum.id === id);

function emptyState() {
  return {
    user: null,
    points: 0,
    collection: [],
    missionCollection: [],
    purchases: [],
    installedRewardId: null,
  };
}

async function boot() {
  renderShellLoading();

  try {
    const [artworksResult, museumsResult, postsResult] = await Promise.all([
      api("/api/artworks"),
      api("/api/museums"),
      api("/api/posts"),
    ]);

    ARTWORKS = artworksResult.artworks;
    MUSEUMS = museumsResult.museums;
    POSTS = postsResult.posts;

    const remembered = getRememberedNickname();
    if (remembered) {
      await restoreSession(remembered);
    }

    renderAll();
  } catch (error) {
    console.error(error);
    renderOfflineError();
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "api_error");
  }
  return payload;
}

function getRememberedNickname() {
  const current = localStorage.getItem(SESSION_KEY);
  if (current) return current;

  try {
    const oldState = JSON.parse(localStorage.getItem(OLD_STORAGE_KEY));
    return oldState?.user?.nickname || "";
  } catch {
    return "";
  }
}

function rememberNickname(nickname) {
  localStorage.setItem(SESSION_KEY, nickname);
}

function clearRememberedNickname() {
  localStorage.removeItem(SESSION_KEY);
}

function applyServerState(user, serverState) {
  state = {
    user,
    points: serverState.points || 0,
    collection: serverState.collection || [],
    missionCollection: serverState.missionCollection || [],
    purchases: serverState.purchases || [],
    installedRewardId: serverState.installedRewardId || null,
  };
}

async function restoreSession(nickname) {
  try {
    const result = await api(`/api/state?nickname=${encodeURIComponent(nickname)}`);
    applyServerState(result.user, result.state);
    rememberNickname(result.user.nickname);
  } catch {
    clearRememberedNickname();
  }
}

async function loginUser(nickname, password) {
  const result = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ nickname, password }),
  });
  applyServerState(result.user, result.state);
  rememberNickname(result.user.nickname);
  location.hash = "#scan";
  renderAll();
  toast(`${result.user.nickname}님, 환영합니다.`);
}

async function signupUser(nickname, password) {
  const result = await api("/api/signup", {
    method: "POST",
    body: JSON.stringify({ nickname, password }),
  });
  applyServerState(result.user, result.state);
  rememberNickname(result.user.nickname);
  location.hash = "#scan";
  renderAll();
  toast(`${result.user.nickname}님, 가입을 환영합니다.`);
}

function renderShellLoading() {
  $("#catalogGrid").innerHTML = `<div class="collection-empty">데이터를 불러오는 중입니다</div>`;
  $("#recommendations").innerHTML = "";
  $("#dailyMission").innerHTML = `<div class="collection-empty">오늘의 미션 준비 중</div>`;
  $("#collectionGrid").innerHTML = `<div class="collection-empty">컬렉션 준비 중</div>`;
  $("#postList").innerHTML = `<div class="collection-empty">게시판 준비 중</div>`;
  renderAuth();
  renderStatus();
  renderRoute();
}

function renderOfflineError() {
  const message = `<div class="collection-empty">서버를 실행한 뒤 다시 열어주세요</div>`;
  $("#catalogGrid").innerHTML = message;
  $("#dailyMission").innerHTML = message;
  $("#collectionGrid").innerHTML = message;
  $("#postList").innerHTML = message;
  toast("DB API에 연결하지 못했습니다.");
}

function renderAll() {
  renderAuth();
  renderStatus();
  renderRoute();

  const route = currentRoute();
  if (route === "scan") renderScanPage();
  if (route === "collection") renderCollectionPage();
  if (route === "community") renderCommunityPage();
}

function renderRoute() {
  const route = currentRoute();
  document.querySelectorAll("[data-page]").forEach((page) => {
    page.classList.toggle("is-active", page.dataset.page === route);
  });
  document.querySelectorAll("[data-route-link]").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.routeLink === route);
  });
}

function currentRoute() {
  const route = (location.hash || "#scan").replace("#", "");
  if (["scan", "collection", "community", "login", "signup"].includes(route)) return route;
  return "scan";
}

function renderScanPage() {
  renderFilters();
  renderCatalog();
  renderMission();
  renderRewards();
  if (latestScan) {
    renderAnalysis(latestScan.features, latestScan.recommendations);
  }
}

function renderCollectionPage() {
  renderCollection();
}

function renderCommunityPage() {
  renderBoardSearchPanel();
  renderPostOptions();
  renderPosts();
}

function renderAuth() {
  const authArea = $("#authArea");
  if (state.user) {
    authArea.innerHTML = `
      <div class="user-pill">
        <span>${escapeHtml(state.user.nickname)}</span>
        <button class="ghost-button" data-action="logout">로그아웃</button>
      </div>`;
    return;
  }

  authArea.innerHTML = `
    <div class="auth-buttons">
      <a class="ghost-button" href="#login">로그인</a>
      <a class="primary-link" href="#signup">회원가입</a>
    </div>`;
}

function renderStatus() {
  const installed = byId(state.installedRewardId);
  $("#titleBadge").textContent = getTitle();
  $("#pointTotal").textContent = `${state.points}P`;
  $("#collectionCount").textContent = `${uniqueCollectionCount()}점`;
  $("#installedRewardName").textContent = installed ? installed.title : "없음";
  $("#missionCount").textContent = `${state.missionCollection.length}점`;
}

function renderFilters() {
  $("#filterBar").innerHTML = FILTERS.map(
    (filter) => `
      <button class="chip ${filter === activeFilter ? "is-active" : ""}" data-action="filter" data-filter="${escapeHtml(filter)}">
        ${escapeHtml(filter)}
      </button>`,
  ).join("");
}

function renderCatalog() {
  const list = nonPremiumArtworks().filter((art) => {
    if (activeFilter === "전체") return true;
    return (
      art.origin === activeFilter ||
      art.period === activeFilter ||
      art.category.includes(activeFilter) ||
      art.tags.includes(activeFilter)
    );
  });

  $("#catalogGrid").innerHTML = list.map((art) => renderArtworkCard(art)).join("");
  setupLazyImages($("#catalogGrid"));
}

function renderMission() {
  const mission = getDailyMission();
  if (!mission) return;

  const matched = latestScan?.recommendations.some((rec) => rec.art.id === mission.id);
  const missionDone = hasCollection(mission.id, "미션");

  $("#dailyMission").innerHTML = `
    <div class="mission-card">
      ${renderArtworkCard(mission, { actions: false })}
      <div class="mission-copy">
        <strong>${missionDone ? "완료" : matched ? "추천 결과에 등장" : "타깃 작품"}</strong>
        <div>성공 보상 +80P · ${escapeHtml(todayKey())}</div>
        <div class="card-actions">
          <button data-action="mission-save" data-art="${mission.id}" ${!matched || missionDone ? "disabled" : ""}>미션 컬렉션 저장</button>
        </div>
      </div>
    </div>`;

  const items = state.missionCollection
    .slice()
    .reverse()
    .slice(0, 4)
    .map((entry) => {
      const art = byId(entry.artworkId);
      if (!art) return "";
      return `
        <div class="mini-item">
          <div class="mini-thumb" style="${styleVars(art)}">${imageMarkup(art)}</div>
          <div>
            <strong>${escapeHtml(art.title)}</strong>
            <span>${escapeHtml(entry.dateKey || "미션")}</span>
          </div>
        </div>`;
    })
    .join("");

  $("#missionCollectionMini").innerHTML = items || `<div class="collection-empty">미션 기록 없음</div>`;
  setupLazyImages($("#dailyMission"));
  setupLazyImages($("#missionCollectionMini"));
}

function renderRewards() {
  $("#rewardGrid").innerHTML = premiumArtworks()
    .map((art) => {
      const purchased = state.purchases.includes(art.id);
      const installed = state.installedRewardId === art.id;
      const canBuy = state.points >= art.cost;
      const button = purchased
        ? `<button data-action="install-reward" data-art="${art.id}" ${installed ? "disabled" : ""}>${installed ? "설치 중" : "설치"}</button>`
        : `<button data-action="buy-reward" data-art="${art.id}" ${canBuy ? "" : "disabled"}>${canBuy ? "교환" : "포인트 부족"}</button>`;

      return `
        <article class="reward-card">
          <figure class="art-thumb" style="${styleVars(art)}">
            <button class="art-image-button" data-action="open-image" data-art="${art.id}" aria-label="${escapeHtml(art.title)} 이미지 확대">
              ${imageMarkup(art)}
            </button>
            <figcaption>${escapeHtml(art.artist)}</figcaption>
          </figure>
          <div class="reward-info">
            <div class="reward-title">
              <h3>${escapeHtml(art.title)}</h3>
              <span class="cost-pill">${art.cost}P</span>
            </div>
            <div class="art-tags">
              ${art.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
            </div>
            ${button}
          </div>
        </article>`;
    })
    .join("");
  setupLazyImages($("#rewardGrid"));
}

function renderCollection() {
  const installed = byId(state.installedRewardId);
  const stage = $("#collectionStage");
  stage.classList.toggle("has-install", Boolean(installed));
  stage.style.setProperty(
    "--installed-image",
    installed?.image ? `url("${encodeURI(installed.image)}")` : "none",
  );

  $("#collectionTabs").innerHTML = COLLECTION_TABS.map(
    (tab) => `
      <button class="chip ${tab === collectionTab ? "is-active" : ""}" data-action="collection-tab" data-tab="${escapeHtml(tab)}">
        ${escapeHtml(tab)}
      </button>`,
  ).join("");

  const entries = mergedCollection().filter((entry) => {
    if (collectionTab === "전체") return true;
    return entry.source === collectionTab;
  });

  if (!entries.length) {
    $("#collectionGrid").innerHTML = `<div class="collection-empty">아직 수집한 작품이 없습니다</div>`;
    return;
  }

  $("#collectionGrid").innerHTML = entries
    .map((entry) => {
      const art = byId(entry.artworkId);
      if (!art) return "";
      return renderArtworkCard(art, { actions: false });
    })
    .join("");
  setupLazyImages($("#collectionGrid"));
}

function renderMuseumControls() {
  $("#museumScope").innerHTML = MUSEUM_SCOPES.map(
    (scope) => `
      <button type="button" class="${scope === museumScope ? "is-active" : ""}" data-action="museum-scope" data-scope="${escapeHtml(scope)}">
        ${escapeHtml(scope)}
      </button>`,
  ).join("");

  const tags = ["전체", ...new Set(MUSEUMS.flatMap((museum) => museum.tags))];
  $("#museumTags").innerHTML = tags
    .map(
      (tag) => `
        <button class="chip ${tag === museumTag ? "is-active" : ""}" data-action="museum-tag" data-tag="${escapeHtml(tag)}">
          ${escapeHtml(tag)}
        </button>`,
    )
    .join("");
}

function renderMuseums() {
  const query = $("#museumSearch")?.value.trim().toLowerCase() || "";
  const list = MUSEUMS.filter((museum) => {
    const scopeMatch = museumScope === "전체" || museum.scope === museumScope;
    const tagMatch = museumTag === "전체" || museum.tags.includes(museumTag);
    const queryMatch =
      !query ||
      `${museum.name} ${museum.city} ${museum.scope} ${museum.tags.join(" ")}`
        .toLowerCase()
        .includes(query);
    return scopeMatch && tagMatch && queryMatch;
  });

  $("#museumList").innerHTML = list
    .map(
      (museum) => `
        <article class="museum-row ${activeMuseumId === museum.id ? "is-active" : ""}" data-action="museum-select" data-museum="${museum.id}">
          <h3>${escapeHtml(museum.name)}</h3>
          <p>${escapeHtml(museum.scope)} · ${escapeHtml(museum.city)}</p>
          <div class="tag-row">
            ${museum.tags.map((tag) => `<span class="museum-tag">${escapeHtml(tag)}</span>`).join("")}
          </div>
        </article>`,
    )
    .join("");
}

function renderPostOptions() {
  $("#postMuseum").innerHTML = MUSEUMS.map(
    (museum) => `<option value="${museum.id}">${escapeHtml(museum.name)}</option>`,
  ).join("");
  $("#postArtwork").innerHTML = nonPremiumArtworks()
    .map((art) => `<option value="${art.id}">${escapeHtml(art.title)}</option>`)
    .join("");

  $("#boardSearchMuseum").innerHTML = [
    `<option value="전체">전체 미술관</option>`,
    ...MUSEUMS.map((museum) => `<option value="${museum.id}">${escapeHtml(museum.name)}</option>`),
  ].join("");
  $("#boardSearchMuseum").value = boardSearchMuseumId;
  $("#boardSearchInput").value = boardSearchQuery;
}

function renderPosts() {
  const normalizedQuery = boardSearchQuery.trim().toLowerCase();
  const posts = POSTS.filter((post) => {
    const museum = museumById(post.museumId);
    const art = byId(post.artworkId);
    const museumMatch = boardSearchMuseumId === "전체" || post.museumId === boardSearchMuseumId;
    const querySource = `${post.title} ${post.body} ${museum?.name || ""} ${art?.title || ""}`.toLowerCase();
    const queryMatch = !normalizedQuery || querySource.includes(normalizedQuery);
    return museumMatch && queryMatch;
  });

  const summary = [];
  if (boardSearchMuseumId !== "전체") summary.push(museumById(boardSearchMuseumId)?.name || "미술관");
  if (boardSearchQuery.trim()) summary.push(`"${boardSearchQuery.trim()}"`);
  $("#boardFilterSummary").innerHTML = summary.length
    ? `<span>${posts.length}개의 글 · ${summary.map(escapeHtml).join(" · ")}</span><button class="ghost-button" data-action="clear-board-search" type="button">초기화</button>`
    : `<span>전체 글 ${posts.length}개</span>`;

  $("#postList").innerHTML = posts
    .map((post) => {
      const museum = museumById(post.museumId);
      const art = byId(post.artworkId);
      return `
        <article class="post-card">
          <div class="post-meta">
            <span>${escapeHtml(post.author)}</span>
            <span>${formatDate(post.createdAt)}</span>
            <span>좋아요 ${post.likes}</span>
          </div>
          <h3>${escapeHtml(post.title)}</h3>
          <p>${escapeHtml(post.body)}</p>
          <div class="tag-row">
            ${museum ? `<span class="post-tag">${escapeHtml(museum.name)}</span>` : ""}
            ${art ? `<span class="post-tag">${escapeHtml(art.title)}</span>` : ""}
          </div>
        </article>`;
    })
    .join("") || `<div class="collection-empty">검색 결과가 없습니다</div>`;
}

function renderBoardSearchPanel() {
  const panel = $("#boardSearchPanel");
  panel.hidden = !boardSearchOpen;
}

function renderArtworkCard(art, options = {}) {
  const score = options.score ? `<span class="score-pill">${options.score}%</span>` : "";
  const mission = getDailyMission();
  const canMissionSave = latestScan && mission && art.id === mission.id;
  const collected = hasCollection(art.id, "일반");
  const missionCollected = hasCollection(art.id, "미션");

  let actions = "";
  if (options.actions !== false) {
    const collectText = collected ? "담김" : "컬렉션";
    const missionButton = canMissionSave
      ? `<button data-action="mission-save" data-art="${art.id}" ${missionCollected ? "disabled" : ""}>미션 저장</button>`
      : "";
    actions = `
      <div class="card-actions">
        <button data-action="collect" data-art="${art.id}" ${collected ? "disabled" : ""}>${collectText}</button>
        ${missionButton}
      </div>`;
  }

  return `
    <article class="art-card">
      <figure class="art-thumb" style="${styleVars(art)}">
        <button class="art-image-button" data-action="open-image" data-art="${art.id}" aria-label="${escapeHtml(art.title)} 이미지 확대">
          ${imageMarkup(art)}
        </button>
        <figcaption>${escapeHtml(art.artist)} · ${escapeHtml(art.year)}</figcaption>
      </figure>
      <div class="art-body">
        <div class="art-title-row">
          <h3>${escapeHtml(art.title)}</h3>
          ${score}
        </div>
        <div class="art-meta">${escapeHtml(art.origin)} · ${escapeHtml(art.period)} · ${escapeHtml(art.region)}</div>
        <div class="art-tags">
          ${art.tags.slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}
        </div>
        ${actions}
      </div>
    </article>`;
}

function imageMarkup(art) {
  const fallback = artworkPlaceholder(art);
  const source = art.image ? encodeURI(art.image) : fallback;
  return `<img data-src="${escapeHtml(source)}" data-fallback="${escapeHtml(fallback)}" alt="${escapeHtml(art.title)}" loading="lazy" decoding="async" />`;
}

function setupLazyImages(root = document) {
  const images = Array.from(root.querySelectorAll("img[data-src]"));
  if (!images.length) return;

  if (!("IntersectionObserver" in window)) {
    images.forEach(loadLazyImage);
    return;
  }

  if (!lazyObserver) {
    lazyObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          loadLazyImage(entry.target);
          lazyObserver.unobserve(entry.target);
        });
      },
      { rootMargin: "160px" },
    );
  }

  images.forEach((image) => {
    image.addEventListener(
      "error",
      () => {
        useFallbackImage(image);
      },
      { once: true },
    );
    lazyObserver.observe(image);
  });
}

function loadLazyImage(image) {
  if (!image.dataset.src) return;
  image.src = image.dataset.src;
  image.removeAttribute("data-src");
}

function useFallbackImage(image) {
  const fallback = image.dataset.fallback;
  if (!fallback || image.src === fallback) {
    image.style.display = "none";
    return;
  }
  image.src = fallback;
}

function artworkPlaceholder(art) {
  const accent = colorToCss(art.palette || [255, 112, 72]);
  const second = colorToCss(secondColor(art.palette || [255, 112, 72]));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="660" viewBox="0 0 900 660">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="${accent}" offset="0"/>
          <stop stop-color="${second}" offset="1"/>
        </linearGradient>
      </defs>
      <rect width="900" height="660" fill="url(#g)"/>
      <rect x="54" y="54" width="792" height="552" rx="28" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.5)" stroke-width="3"/>
      <circle cx="730" cy="145" r="58" fill="rgba(255,255,255,0.22)"/>
      <path d="M130 490 C230 380 310 430 390 330 C480 220 590 270 765 145 L765 560 L130 560 Z" fill="rgba(31,27,24,0.18)"/>
      <text x="96" y="130" font-family="Arial, sans-serif" font-size="36" font-weight="700" fill="white">ArtCatch</text>
      <text x="96" y="186" font-family="Arial, sans-serif" font-size="26" fill="white">${escapeXml(art.title)}</text>
      <text x="96" y="224" font-family="Arial, sans-serif" font-size="20" fill="rgba(255,255,255,0.82)">${escapeXml(art.artist)}</text>
    </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function styleVars(art) {
  return `--thumb-a: ${colorToCss(art.palette)}; --thumb-b: ${colorToCss(secondColor(art.palette))};`;
}

function colorToCss(color) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function secondColor(color) {
  return [
    Math.min(255, Math.round(color[0] * 0.65 + 92)),
    Math.min(255, Math.round(color[1] * 0.65 + 72)),
    Math.min(255, Math.round(color[2] * 0.65 + 62)),
  ];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getDailyMission() {
  const list = nonPremiumArtworks();
  if (!list.length) return null;
  const date = new Date();
  const dateKey = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  const seed = [...dateKey].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return list[seed % list.length];
}

function todayKey() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function uniqueCollectionCount() {
  return new Set(mergedCollection().map((entry) => `${entry.source}-${entry.artworkId}-${entry.dateKey || ""}`)).size;
}

function mergedCollection() {
  const rewardEntries = state.purchases.map((id) => ({
    artworkId: id,
    source: "보상",
    createdAt: new Date().toISOString(),
  }));
  return [...state.collection, ...state.missionCollection, ...rewardEntries];
}

function hasCollection(artworkId, source) {
  if (source === "미션") {
    return state.missionCollection.some((entry) => {
      return entry.artworkId === artworkId && entry.dateKey === todayKey();
    });
  }
  return state.collection.some((entry) => entry.artworkId === artworkId);
}

function getTitle() {
  return TITLE_STEPS.find(([min]) => state.points >= min)?.[1] || "새내기 감상가";
}

function requireLogin() {
  if (state.user) return true;
  toast("로그인 후 저장할 수 있어요.");
  location.hash = "#login";
  return false;
}

async function collectArtwork(artworkId) {
  if (!requireLogin() || hasCollection(artworkId, "일반")) return;
  const result = await api("/api/collections", {
    method: "POST",
    body: JSON.stringify({
      nickname: state.user.nickname,
      artworkId,
      source: "일반",
    }),
  });
  applyServerState(state.user, result.state);
  renderAll();
  toast("컬렉션에 담고 12P를 받았습니다.");
}

async function saveMission(artworkId) {
  if (!requireLogin()) return;
  const mission = getDailyMission();
  if (!mission || artworkId !== mission.id) {
    toast("오늘의 미션 작품만 저장됩니다.");
    return;
  }
  if (!latestScan?.recommendations.some((rec) => rec.art.id === mission.id)) {
    toast("사진 추천 결과에 오늘의 작품이 필요합니다.");
    return;
  }
  if (hasCollection(artworkId, "미션")) return;

  const result = await api("/api/collections", {
    method: "POST",
    body: JSON.stringify({
      nickname: state.user.nickname,
      artworkId,
      source: "미션",
      dateKey: todayKey(),
    }),
  });
  applyServerState(state.user, result.state);
  renderAll();
  toast("미션 컬렉션에 저장하고 80P를 받았습니다.");
}

async function buyReward(artworkId) {
  if (!requireLogin()) return;
  const art = byId(artworkId);
  if (!art) return;

  try {
    const result = await api("/api/rewards/buy", {
      method: "POST",
      body: JSON.stringify({ nickname: state.user.nickname, artworkId }),
    });
    applyServerState(state.user, result.state);
    renderAll();
    toast(`${art.title}을 컬렉션에 설치했습니다.`);
  } catch (error) {
    toast(error.message === "not_enough_points" ? "포인트가 부족합니다." : "보상을 교환하지 못했습니다.");
  }
}

async function installReward(artworkId) {
  if (!state.user || !state.purchases.includes(artworkId)) return;
  const art = byId(artworkId);
  const result = await api("/api/rewards/install", {
    method: "POST",
    body: JSON.stringify({ nickname: state.user.nickname, artworkId }),
  });
  applyServerState(state.user, result.state);
  renderAll();
  toast(`${art.title}을 설치했습니다.`);
}

function analyzeImage(file) {
  if (!file) return;

  const url = URL.createObjectURL(file);
  const preview = $("#previewFrame");
  preview.innerHTML = `<img src="${url}" alt="선택한 사진 미리보기" />`;

  const image = new Image();
  image.onload = () => {
    const features = sampleImageFeatures(image);
    const recommendations = recommendByVisualFeatures(features);
    latestScan = { color: features.color, features, recommendations };
    renderAnalysis(features, recommendations);
    renderMission();
    URL.revokeObjectURL(url);
  };
  image.onerror = () => {
    toast("이미지를 읽지 못했습니다.");
    URL.revokeObjectURL(url);
  };
  image.src = url;
}

function sampleImageFeatures(image) {
  const canvas = document.createElement("canvas");
  const size = 64;
  const ratio = image.width / image.height;
  canvas.width = ratio >= 1 ? size : Math.max(1, Math.round(size * ratio));
  canvas.height = ratio >= 1 ? Math.max(1, Math.round(size / ratio)) : size;

  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  let skin = 0;
  let sky = 0;
  let foliage = 0;
  let ink = 0;
  let bright = 0;
  let topBlue = 0;
  let bottomGreen = 0;
  let edgeTotal = 0;

  for (let index = 0; index < data.length; index += 4) {
    const pixelIndex = index / 4;
    const x = pixelIndex % canvas.width;
    const y = Math.floor(pixelIndex / canvas.width);
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    red += r;
    green += g;
    blue += b;
    if (isSkinTone(r, g, b)) skin += 1;
    if (b > r + 18 && b > g + 5 && luminance > 92) sky += 1;
    if (g > r + 8 && g > b + 6 && luminance > 55) foliage += 1;
    if (luminance < 78 && Math.max(r, g, b) - Math.min(r, g, b) < 34) ink += 1;
    if (luminance > 190) bright += 1;
    if (y < canvas.height * 0.45 && b > r + 14) topBlue += 1;
    if (y > canvas.height * 0.55 && g > r + 6 && g > b + 4) bottomGreen += 1;

    if (x > 0 && y > 0) {
      const leftIndex = index - 4;
      const topIndex = index - canvas.width * 4;
      const leftLum = 0.2126 * data[leftIndex] + 0.7152 * data[leftIndex + 1] + 0.0722 * data[leftIndex + 2];
      const topLum = 0.2126 * data[topIndex] + 0.7152 * data[topIndex + 1] + 0.0722 * data[topIndex + 2];
      if (Math.abs(luminance - leftLum) + Math.abs(luminance - topLum) > 92) edgeTotal += 1;
    }
    count += 1;
  }

  const color = [
    Math.round(red / count),
    Math.round(green / count),
    Math.round(blue / count),
  ];

  const landscapeScore = Math.min(1, sky / count + foliage / count + topBlue / count + bottomGreen / count);
  const portraitScore = Math.min(1, skin / count * 5.5);
  const inkScore = Math.min(1, ink / count * 3 + bright / count * 0.7);
  const detailScore = Math.min(1, edgeTotal / count * 4);

  return {
    color,
    landscapeScore,
    portraitScore,
    inkScore,
    detailScore,
    skyRatio: sky / count,
    foliageRatio: foliage / count,
    skinRatio: skin / count,
    brightRatio: bright / count,
    inkRatio: ink / count,
  };
}

function isSkinTone(red, green, blue) {
  return red > 95 && green > 40 && blue > 20 && red > green && green > blue && red - blue > 15;
}

function recommendByVisualFeatures(features) {
  return nonPremiumArtworks()
    .map((art) => {
      const profile = artworkVisualProfile(art);
      const distance = colorDistance(features.color, art.palette);
      const colorScore = Math.max(0, 42 - distance / 5);
      const sceneScore =
        (1 - Math.abs(features.portraitScore - profile.portrait)) * 18 +
        (1 - Math.abs(features.landscapeScore - profile.landscape)) * 18 +
        (1 - Math.abs(features.inkScore - profile.ink)) * 12 +
        (1 - Math.abs(features.detailScore - profile.detail)) * 8;
      const warmthBonus = warmth(features.color) === warmth(art.palette) ? 5 : 0;
      const score = Math.max(42, Math.min(98, Math.round(colorScore + sceneScore + warmthBonus)));
      return { art, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

function artworkVisualProfile(art) {
  const text = [...art.tags, ...art.category, art.period, art.origin].join(" ");
  const hasAny = (words) => words.some((word) => text.includes(word));

  return {
    portrait: hasAny(["초상", "인물", "사람"]) ? 0.9 : 0.12,
    landscape: hasAny(["풍경", "산", "바다", "파도", "자연", "연못"]) ? 0.92 : 0.16,
    ink: hasAny(["수묵", "먹", "여백", "한국화", "산수"]) ? 0.86 : 0.18,
    detail: hasAny(["추상", "패턴", "장식", "소용돌이"]) ? 0.82 : 0.42,
  };
}

function colorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function warmth(color) {
  if (color[0] > color[2] + 22) return "따뜻한 색";
  if (color[2] > color[0] + 22) return "차가운 색";
  return "중간 톤";
}

function brightnessBand(color) {
  const value = (color[0] + color[1] + color[2]) / 3;
  if (value > 178) return "밝은";
  if (value < 88) return "어두운";
  return "중간 밝기";
}

function renderAnalysis(features, recommendations) {
  const color = features.color;
  $("#analysisTitle").textContent = `${describeScene(features)} · ${warmth(color)}`;
  $("#analysisCopy").textContent = `로컬 비전 분석으로 색감, 인물 가능성, 풍경 신호, 수묵/여백 신호를 함께 비교했습니다. 가장 가까운 작품은 ${recommendations[0].art.title}입니다.`;
  $("#scanSwatches").innerHTML = [
    color,
    ...recommendations.slice(0, 3).map((item) => item.art.palette),
  ]
    .map((swatch) => `<span class="swatch" style="background:${colorToCss(swatch)}"></span>`)
    .join("");
  $("#recommendations").innerHTML = recommendations
    .map(({ art, score }) => renderArtworkCard(art, { score }))
    .join("");
  setupLazyImages($("#recommendations"));
}

function describeScene(features) {
  const labels = [];
  if (features.portraitScore > 0.35) labels.push("인물 신호");
  if (features.landscapeScore > 0.32) labels.push("풍경 신호");
  if (features.inkScore > 0.45) labels.push("수묵/여백 신호");
  if (features.detailScore > 0.55) labels.push("질감 풍부");
  return labels.slice(0, 2).join(" + ") || brightnessBand(features.color);
}

function openImageModal(artworkId) {
  const art = byId(artworkId);
  if (!art) {
    return;
  }

  const modal = $("#imageModal");
  const modalImage = $("#imageModalImg");
  modalImage.dataset.fallback = artworkPlaceholder(art);
  modalImage.onerror = () => useFallbackImage(modalImage);
  modalImage.src = art.image || modalImage.dataset.fallback;
  modalImage.alt = art.title;
  $("#imageModalTitle").textContent = art.title;
  $("#imageModalMeta").textContent = `${art.artist} · ${art.year} · ${art.period}`;
  modal.classList.add("is-visible");
  modal.setAttribute("aria-hidden", "false");
}

function closeImageModal() {
  const modal = $("#imageModal");
  modal.classList.remove("is-visible");
  modal.setAttribute("aria-hidden", "true");
  $("#imageModalImg").removeAttribute("src");
}

async function createPost(event) {
  event.preventDefault();
  if (!requireLogin()) return;

  const title = $("#postTitle").value.trim();
  const body = $("#postBody").value.trim();
  const museumId = $("#postMuseum").value;
  const artworkId = $("#postArtwork").value;

  if (!title || !body) return;

  const result = await api("/api/posts", {
    method: "POST",
    body: JSON.stringify({
      author: state.user.nickname,
      title,
      body,
      museumId,
      artworkId,
    }),
  });
  POSTS = result.posts;
  event.target.reset();
  renderCommunityPage();
  toast("게시글을 공유했습니다.");
}

function formatDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function toast(message) {
  const toastEl = $("#toast");
  toastEl.textContent = message;
  toastEl.classList.add("is-visible");
  clearTimeout(toastEl.hideTimer);
  toastEl.hideTimer = setTimeout(() => {
    toastEl.classList.remove("is-visible");
  }, 2400);
}

function authErrorMessage(error) {
  if (error.message === "not_found") return "서버를 껐다가 node dev-server.mjs로 다시 실행해주세요.";
  if (error.message === "password_required") return "회원가입 페이지에서 비밀번호를 설정해주세요.";
  if (error.message === "nickname_taken") return "이미 사용 중인 닉네임입니다.";
  if (error.message === "login_failed") return "닉네임 또는 비밀번호를 확인해주세요.";
  return "요청을 완료하지 못했습니다.";
}

document.addEventListener("submit", async (event) => {
  if (event.target.id === "loginForm") {
    event.preventDefault();
    const nickname = $("#loginNickname").value.trim();
    const password = $("#loginPassword").value;
    if (!nickname) return;
    if ([...nickname].length > 7) {
      toast("닉네임은 7자까지 가능합니다.");
      return;
    }
    if (password.length < 4) {
      toast("비밀번호는 4자 이상 입력해주세요.");
      return;
    }
    try {
      await loginUser(nickname, password);
    } catch (error) {
      toast(authErrorMessage(error));
    }
  }

  if (event.target.id === "signupForm") {
    event.preventDefault();
    const nickname = $("#signupNickname").value.trim();
    const password = $("#signupPassword").value;
    if (!nickname) return;
    if ([...nickname].length > 7) {
      toast("닉네임은 7자까지 가능합니다.");
      return;
    }
    if (password.length < 4) {
      toast("비밀번호는 4자 이상 입력해주세요.");
      return;
    }
    try {
      await signupUser(nickname, password);
    } catch (error) {
      toast(authErrorMessage(error));
    }
  }

  if (event.target.id === "postForm") {
    await createPost(event);
  }

  if (event.target.id === "boardSearchForm") {
    event.preventDefault();
    boardSearchQuery = $("#boardSearchInput").value;
    boardSearchMuseumId = $("#boardSearchMuseum").value;
    renderPosts();
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  if (action === "logout") {
    state = emptyState();
    clearRememberedNickname();
    renderAll();
    toast("로그아웃했습니다.");
  }

  if (action === "toggle-board-search") {
    boardSearchOpen = !boardSearchOpen;
    renderBoardSearchPanel();
  }

  if (action === "clear-board-search") {
    boardSearchQuery = "";
    boardSearchMuseumId = "전체";
    renderPostOptions();
    renderPosts();
  }

  if (action === "open-image") {
    openImageModal(target.dataset.art);
  }

  if (action === "close-image") {
    closeImageModal();
  }

  if (action === "filter") {
    activeFilter = target.dataset.filter;
    renderFilters();
    renderCatalog();
  }

  if (action === "collection-tab") {
    collectionTab = target.dataset.tab;
    renderCollection();
  }

  if (action === "collect") {
    await collectArtwork(target.dataset.art);
  }

  if (action === "mission-save") {
    await saveMission(target.dataset.art);
  }

  if (action === "buy-reward") {
    await buyReward(target.dataset.art);
  }

  if (action === "install-reward") {
    await installReward(target.dataset.art);
  }

  if (action === "museum-scope") {
    museumScope = target.dataset.scope;
    renderMuseumControls();
    renderMuseums();
  }

  if (action === "museum-tag") {
    museumTag = target.dataset.tag;
    renderMuseumControls();
    renderMuseums();
  }

  if (action === "museum-select") {
    activeMuseumId = activeMuseumId === target.dataset.museum ? "전체" : target.dataset.museum;
    renderMuseums();
    renderPosts();
  }
});

$("#photoInput").addEventListener("change", (event) => {
  analyzeImage(event.target.files[0]);
});

$("#museumSearch")?.addEventListener("input", renderMuseums);

window.addEventListener("hashchange", renderAll);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeImageModal();
});

boot();
