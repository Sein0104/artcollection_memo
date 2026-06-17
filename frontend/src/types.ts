export type Artwork = {
  id: string;
  title: string;
  artist: string;
  year: string;
  origin: string;
  period: string;
  region: string;
  category: string[];
  tags: string[];
  palette: number[];
  image?: string | null;
  premium: boolean;
  cost: number;
};

export type Museum = {
  id: string;
  name: string;
  scope: string;
  country: string;
  area: string;
  city: string;
  tags: string[];
};

export type Post = {
  id: string;
  author: string;
  authorTitle?: string;
  title: string;
  body: string;
  tags?: string[];
  boardType: "free" | "review";
  status?: "published" | "held" | "rejected";
  museumId: string;
  museumName?: string;
  museumScope?: string;
  museumCountry?: string;
  museumArea?: string;
  upVotes: number;
  downVotes: number;
  commentCount: number;
  createdAt: string;
};

export type PostComment = {
  id: string;
  author: string;
  authorTitle?: string;
  body: string;
  status?: "published" | "held" | "rejected";
  parentId?: string | null;
  createdAt: string;
  replies: PostComment[];
};

export type PostDetail = Post & {
  comments: PostComment[];
};

export type PostListMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
};

export type PostListResponse = {
  posts: Post[];
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  hasPrev?: boolean;
  hasNext?: boolean;
};

export type UserState = {
  points: number;
  totalEarnedPoints: number;
  installedRewardId: string | null;
  collection: Array<{ artworkId: string; source: string; createdAt: string }>;
  missionCollection: Array<{ artworkId: string; source: string; dateKey?: string; createdAt: string }>;
  purchases: string[];
};

export type Session = {
  user: { id?: string; nickname: string; email?: string | null; avatarUrl?: string | null } | null;
  state: UserState;
};

export type DailyMissions = {
  dateKey: string;
  missions: Artwork[];
};

export type MissionAnalysis = {
  score: number;
  passed: boolean;
  feedback: string;
  coachTip?: string;
};

export type AiDocentResponse = {
  answer: string;
  suggestedArtworks: Artwork[];
  sources: AiDocentSource[];
};

export type AiDocentSource = {
  type: "daily_mission" | "artwork_knowledge" | "user_collection" | "museum";
  title: string;
  artworkId?: string;
  sourceType?: string;
  detail?: string;
};

export type ExternalSearchResult = {
  title: string;
  snippet: string;
  url: string;
  source: string;
};

export type ExternalSearchResponse = {
  query: string;
  provider: "mcp";
  configured: boolean;
  results: ExternalSearchResult[];
  message?: string;
};

export type ImageSearchMatch = {
  similarity: number;
  artwork: Artwork;
};

export type ImageMatchExplanation = {
  summary: string;
  similarParts: string[];
  differentParts: string[];
  confidence: "high" | "medium" | "low";
};

export type ImageSearchResponse = {
  model: string;
  dimensions: number;
  artworkCount: number;
  indexedCount: number;
  ready: boolean;
  bestMatch?: ImageSearchMatch | null;
  explanation?: ImageMatchExplanation | null;
  candidateCount?: number;
  rankedArtworkIds?: string[];
  reranked?: boolean;
  matches: ImageSearchMatch[];
};

export type ModerationNotice = {
  action: "allow" | "warn" | "hold" | "report";
  severity: number;
  confidence: number;
  categories: string[];
  authorMessage: string;
};

export type ModerationCase = {
  id: string;
  targetType: "post" | "comment";
  targetId: string;
  action: "allow" | "warn" | "hold" | "report";
  severity: number;
  confidence: number;
  categories: string[];
  reason: string;
  authorMessage: string;
  adminSummary: string;
  status: string;
  reviewerNote: string;
  createdAt: string;
  author: string;
  content: {
    title: string;
    body: string;
    museumName: string;
  };
};
