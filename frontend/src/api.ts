import type { Artwork, DailyMissions, MissionAnalysis, Museum, Post, PostDetail, Session, UserState } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
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
  artworks: () => request<{ artworks: Artwork[] }>("/artworks"),
  museums: () => request<{ museums: Museum[] }>("/museums"),
  posts: () => request<{ posts: Post[] }>("/posts"),
  post: (id: string) => request<{ post: PostDetail }>(`/posts/${encodeURIComponent(id)}`),
  signup: (nickname: string, password: string) =>
    request<Session>("/auth/signup", { method: "POST", body: JSON.stringify({ nickname, password }) }),
  login: (nickname: string, password: string) =>
    request<Session>("/auth/login", { method: "POST", body: JSON.stringify({ nickname, password }) }),
  state: (nickname: string) => request<Session>(`/auth/state?nickname=${encodeURIComponent(nickname)}`),
  buyReward: (nickname: string, artworkId: string) =>
    request<{ state: UserState }>("/rewards/buy", { method: "POST", body: JSON.stringify({ nickname, artworkId }) }),
  installReward: (nickname: string, artworkId: string) =>
    request<{ state: UserState }>("/rewards/install", { method: "POST", body: JSON.stringify({ nickname, artworkId }) }),
  dailyMissions: () => request<DailyMissions>("/missions/daily"),
  analyzeMission: (artworkId: string, imageDataUrl: string, mode: "capture" | "pose", nickname?: string) =>
    request<MissionAnalysis>("/missions/analyze", {
      method: "POST",
      body: JSON.stringify({ artworkId, imageDataUrl, mode, nickname }),
    }),
  completeMission: (nickname: string, artworkId: string) =>
    request<{ state: UserState }>("/missions/complete", {
      method: "POST",
      body: JSON.stringify({ nickname, artworkId }),
    }),
  createPost: (body: {
    nickname: string;
    title: string;
    body: string;
    museumId: string;
    boardType: "free" | "review";
  }) => request<{ posts: Post[] }>("/posts", { method: "POST", body: JSON.stringify(body) }),
  createComment: (postId: string, body: { nickname: string; body: string; parentId?: string }) =>
    request<{ post: PostDetail }>(`/posts/${encodeURIComponent(postId)}/comments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  votePost: (postId: string, body: { nickname: string; type: "up" | "down" }) =>
    request<{ post: PostDetail }>(`/posts/${encodeURIComponent(postId)}/vote`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updatePost: (postId: string, body: { nickname: string; title: string; body: string }) =>
    request<{ post: PostDetail }>(`/posts/${encodeURIComponent(postId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deletePost: (postId: string, nickname: string) =>
    request<{ posts: Post[] }>(`/posts/${encodeURIComponent(postId)}`, {
      method: "DELETE",
      body: JSON.stringify({ nickname }),
    }),
};
