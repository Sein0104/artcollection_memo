import type {
  AiDocentResponse,
  Artwork,
  DailyMissions,
  ExternalSearchResponse,
  MissionAnalysis,
  ModerationNotice,
  Museum,
  Post,
  PostDetail,
  Session,
  UserState,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};

  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }

  if (!response.ok) {
    const message = payload.message || payload.error || `api_${response.status}`;
    throw new Error(String(message));
  }

  return payload as T;
}

export const api = {
  googleLoginUrl: () => `${API_BASE}/auth/google`,
  googleStatus: () => request<{ configured: boolean; callbackUrl: string }>("/auth/google/status"),
  artworks: () => request<{ artworks: Artwork[] }>("/artworks"),
  museums: () => request<{ museums: Museum[] }>("/museums"),
  posts: () => request<{ posts: Post[] }>("/posts"),
  post: (id: string) => request<{ post: PostDetail }>(`/posts/${encodeURIComponent(id)}`),
  me: () => request<Session>("/auth/me"),
  state: () => request<Session>("/auth/state"),
  logout: () => request<Session>("/auth/logout", { method: "POST" }),
  buyReward: (artworkId: string) =>
    request<{ state: UserState }>("/rewards/buy", { method: "POST", body: JSON.stringify({ artworkId }) }),
  installReward: (artworkId: string) =>
    request<{ state: UserState }>("/rewards/install", { method: "POST", body: JSON.stringify({ artworkId }) }),
  dailyMissions: () => request<DailyMissions>("/missions/daily"),
  analyzeMission: (artworkId: string, imageDataUrl: string, mode: "capture" | "pose") =>
    request<MissionAnalysis>("/missions/analyze", {
      method: "POST",
      body: JSON.stringify({ artworkId, imageDataUrl, mode }),
    }),
  completeMission: (artworkId: string) =>
    request<{ state: UserState }>("/missions/complete", {
      method: "POST",
      body: JSON.stringify({ artworkId }),
    }),
  createPost: (body: {
    title: string;
    body: string;
    museumId: string;
    boardType: "free" | "review";
  }) => request<{ posts: Post[]; moderation?: ModerationNotice }>("/posts", { method: "POST", body: JSON.stringify(body) }),
  createComment: (postId: string, body: { body: string; parentId?: string }) =>
    request<{ post: PostDetail; moderation?: ModerationNotice }>(`/posts/${encodeURIComponent(postId)}/comments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteComment: (postId: string, commentId: string) =>
    request<{ post: PostDetail }>(`/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`, {
      method: "DELETE",
    }),
  votePost: (postId: string, body: { type: "up" | "down" }) =>
    request<{ post: PostDetail }>(`/posts/${encodeURIComponent(postId)}/vote`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updatePost: (postId: string, body: { title: string; body: string }) =>
    request<{ post: PostDetail; moderation?: ModerationNotice }>(`/posts/${encodeURIComponent(postId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deletePost: (postId: string) =>
    request<{ posts: Post[] }>(`/posts/${encodeURIComponent(postId)}`, {
      method: "DELETE",
    }),
  askDocent: (message: string) =>
    request<AiDocentResponse>("/ai-docent/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  externalSearch: (query: string) => request<ExternalSearchResponse>(`/external-search?q=${encodeURIComponent(query)}`),
};
