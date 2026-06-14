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
  boardType: "free" | "review";
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
  parentId?: string | null;
  createdAt: string;
  replies: PostComment[];
};

export type PostDetail = Post & {
  comments: PostComment[];
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
};
