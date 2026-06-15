import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CollectionSource } from "@prisma/client";
import { REMOVED_ARTWORK_IDS, withLocalArtworkImage } from "../artworks/image-overrides";
import { AuthService } from "../auth/auth.service";
import { MissionsService } from "../missions/missions.service";
import { PrismaService } from "../prisma.service";
import { AskDocentDto } from "./dto";

const DOCENT_CONTEXT_LIMIT = 8;
const DOCENT_DYNAMIC_CONTEXT_LIMIT = 6;
const DOCENT_SUGGESTION_LIMIT = 3;
const DOCENT_SOURCE_LIMIT = 8;
const OPENAI_EMBEDDING_TIMEOUT_MS = 20_000;
const OPENAI_DOCENT_TIMEOUT_MS = 45_000;
const KNOWLEDGE_SOURCE_TYPES = ["metadata", "mission_hint", "museum"] as const;

const DOCENT_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "Korean answer grounded in the provided service data and artwork context.",
    },
    suggestedArtworkIds: {
      type: "array",
      items: { type: "string" },
      description: "Artwork ids from the provided context, ordered by relevance.",
    },
  },
  required: ["answer", "suggestedArtworkIds"],
  additionalProperties: false,
} as const;

type DocentSourceType = "daily_mission" | "artwork_knowledge" | "user_collection" | "museum";

type DocentSource = {
  type: DocentSourceType;
  title: string;
  artworkId?: string;
  sourceType?: string;
  detail?: string;
};

type ArtworkForKnowledge = {
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
  image: string | null;
  premium: boolean;
  cost: number;
};

type KnowledgeCandidate = {
  id: string;
  artworkId: string;
  sourceType: string;
  text: string;
  embedding: unknown;
  artwork: ArtworkForKnowledge;
};

type DocentContextItem = {
  key: string;
  text: string;
  source: DocentSource;
  artworkId?: string;
};

type CollectionArtwork = {
  artwork: ArtworkForKnowledge;
  sourceLabel: string;
  createdAt: Date;
};

type DocentIntent = {
  daily: boolean;
  collection: boolean;
  museum: boolean;
};

@Injectable()
export class AiDocentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly missions: MissionsService,
  ) {}

  async chat(dto: AskDocentDto, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);
    const message = dto.message.trim();

    await this.ensureArtworkKnowledge();

    const intent = this.detectIntent(message);
    const daily = await this.missions.daily();
    const dailyArtworks = daily.missions as ArtworkForKnowledge[];
    const collectionArtworks = intent.collection ? await this.userCollectionArtworks(user.id) : [];
    const mentionedArtworks = await this.findMentionedArtworks(message);
    const queryEmbedding = (await this.createEmbeddings([message]))[0];
    const knowledgeScopeIds = intent.daily ? dailyArtworks.map((artwork) => artwork.id) : undefined;
    const candidates = await this.findKnowledgeCandidates(queryEmbedding, knowledgeScopeIds);

    const contextItems = this.buildContextItems({
      message,
      dateKey: daily.dateKey,
      intent,
      dailyArtworks,
      collectionArtworks,
      mentionedArtworks,
      candidates,
    });
    const allowedSuggestedArtworkIds = this.allowedSuggestedArtworkIds({
      intent,
      dailyArtworks,
      collectionArtworks,
      mentionedArtworks,
      candidates,
      contextItems,
    });

    const response = await this.generateDocentAnswer({
      message,
      contextItems,
      intent,
      allowedSuggestedArtworkIds,
    });
    const suggestedArtworkIds = this.normalizeSuggestedArtworkIds(response.suggestedArtworkIds, allowedSuggestedArtworkIds);
    const suggestedArtworks = await this.prisma.artwork.findMany({
      where: { id: { in: suggestedArtworkIds } },
    });
    const byId = new Map(suggestedArtworks.map((artwork) => [artwork.id, withLocalArtworkImage(artwork)]));

    return {
      answer: response.answer,
      suggestedArtworks: suggestedArtworkIds.flatMap((id) => {
        const artwork = byId.get(id);
        return artwork ? [artwork] : [];
      }),
      sources: this.sourcesForResponse(contextItems, suggestedArtworkIds, intent),
    };
  }

  private async ensureArtworkKnowledge() {
    const artworks = await this.prisma.artwork.findMany({
      where: {
        id: { notIn: REMOVED_ARTWORK_IDS },
        image: { not: null },
      },
      orderBy: { id: "asc" },
    });
    const existing = await this.prisma.artworkKnowledge.findMany({
      where: { sourceType: { in: [...KNOWLEDGE_SOURCE_TYPES] } },
      select: { id: true, artworkId: true, sourceType: true, text: true, embedding: true },
    });
    const existingByKey = new Map(existing.map((item) => [`${item.artworkId}:${item.sourceType}`, item]));
    const pending: Array<{ artworkId: string; sourceType: string; text: string }> = [];

    for (const artwork of artworks) {
      for (const entry of this.knowledgeEntriesForArtwork(artwork)) {
        const existingEntry = existingByKey.get(`${entry.artworkId}:${entry.sourceType}`);
        if (!existingEntry || existingEntry.text !== entry.text || !this.toVector(existingEntry.embedding)) {
          pending.push(entry);
        }
      }
    }

    if (!pending.length) return;

    const embeddings = await this.createEmbeddings(pending.map((entry) => entry.text));
    await this.prisma.$transaction(
      pending.map((entry, index) =>
        this.prisma.artworkKnowledge.upsert({
          where: {
            artworkId_sourceType: {
              artworkId: entry.artworkId,
              sourceType: entry.sourceType,
            },
          },
          update: {
            text: entry.text,
            embedding: embeddings[index],
          },
          create: {
            artworkId: entry.artworkId,
            sourceType: entry.sourceType,
            text: entry.text,
            embedding: embeddings[index],
          },
        }),
      ),
    );
  }

  private knowledgeEntriesForArtwork(artwork: ArtworkForKnowledge) {
    const museumSource = this.museumSourceForArtwork(artwork);
    return [
      {
        artworkId: artwork.id,
        sourceType: "metadata",
        text: [
          `작품 ID: ${artwork.id}`,
          `제목: ${artwork.title}`,
          `작가: ${artwork.artist}`,
          `연도: ${artwork.year}`,
          `기원: ${artwork.origin}`,
          `시대/양식: ${artwork.period}`,
          `지역: ${artwork.region}`,
          `분류: ${artwork.category.join(", ")}`,
          `태그: ${artwork.tags.join(", ")}`,
          `대표 색상 RGB: ${artwork.palette.join(", ")}`,
          artwork.premium ? `포인트 상점 작품, 비용: ${artwork.cost}P` : "일반/미션 후보 작품",
        ].join("\n"),
      },
      {
        artworkId: artwork.id,
        sourceType: "mission_hint",
        text: [
          `작품 ID: ${artwork.id}`,
          `작품명: ${artwork.title}`,
          `미션 촬영 힌트: ${artwork.tags.join(", ")} 요소를 중심으로 관찰한다.`,
          `촬영 포인트: 구도, 색감, 분위기, 주제 배치, 빛의 방향을 ${artwork.title}의 인상과 비교한다.`,
          `따라 찍기 질문에 답할 때는 사용자가 현실에서 재현하기 쉬운 장면, 색, 소품, 포즈를 제안한다.`,
        ].join("\n"),
      },
      {
        artworkId: artwork.id,
        sourceType: "museum",
        text: [
          `작품 ID: ${artwork.id}`,
          `작품명: ${artwork.title}`,
          `소장/출처 맥락: ${museumSource}`,
          `지역/시대 정보: ${artwork.region || "미상"} / ${artwork.period || "미상"}`,
          `앱의 박물관·출처 기반 질문에는 이 작품의 공개 이미지 출처, 지역, 시대, 분류 정보를 근거로 답한다.`,
        ].join("\n"),
      },
    ];
  }

  private detectIntent(message: string) {
    const normalized = this.normalizeText(message);
    return {
      daily:
        /오늘|일일미션|일일 미션|데일리|미션작품|미션 작품|today|daily/.test(normalized) &&
        /미션|mission|작품|뭐|추천/.test(normalized),
      collection: /내컬렉션|내 컬렉션|수집|모은|보유|collection|mycollection|my collection/.test(normalized),
      museum: /박물관|미술관|소장|출처|source|museum|어디/.test(normalized),
    };
  }

  private buildContextItems({
    message,
    dateKey,
    intent,
    dailyArtworks,
    collectionArtworks,
    mentionedArtworks,
    candidates,
  }: {
    message: string;
    dateKey: string;
    intent: DocentIntent;
    dailyArtworks: ArtworkForKnowledge[];
    collectionArtworks: CollectionArtwork[];
    mentionedArtworks: ArtworkForKnowledge[];
    candidates: KnowledgeCandidate[];
  }) {
    const items: DocentContextItem[] = [];

    if (intent.daily) {
      for (const [index, artwork] of dailyArtworks.entries()) {
        items.push(this.artworkContextItem({
          key: `daily-${index + 1}`,
          sourceType: "daily_mission",
          artwork,
          detail: `${dateKey} 오늘의 일일미션 ${index + 1}번`,
          extraLines: [`오늘의 일일미션 날짜: ${dateKey}`, `오늘 미션 순서: ${index + 1}`],
        }));
      }
    }

    if (intent.collection) {
      if (!collectionArtworks.length) {
        items.push({
          key: "collection-empty",
          source: {
            type: "user_collection",
            title: "내 컬렉션",
            detail: "현재 사용자의 컬렉션에 수집된 작품이 없습니다.",
          },
          text: "사용자의 현재 컬렉션은 비어 있습니다. 컬렉션 기반 추천을 요청하면 먼저 미션을 완료해 작품을 수집하라고 안내한다.",
        });
      }
      for (const [index, item] of collectionArtworks.slice(0, DOCENT_DYNAMIC_CONTEXT_LIMIT).entries()) {
        items.push(this.artworkContextItem({
          key: `collection-${index + 1}`,
          sourceType: "user_collection",
          artwork: item.artwork,
          detail: `내 컬렉션: ${item.sourceLabel}`,
          extraLines: [`컬렉션 출처: ${item.sourceLabel}`, `수집 시각: ${item.createdAt.toISOString()}`],
        }));
      }
    }

    for (const [index, artwork] of mentionedArtworks.slice(0, DOCENT_DYNAMIC_CONTEXT_LIMIT).entries()) {
      items.push(this.artworkContextItem({
        key: `mentioned-${index + 1}`,
        sourceType: "artwork_knowledge",
        artwork,
        detail: "질문에서 직접 언급된 작품",
        extraLines: [`사용자 질문에서 직접 매칭됨: ${message}`],
      }));
      if (intent.museum) {
        items.push(this.artworkContextItem({
          key: `mentioned-museum-${index + 1}`,
          sourceType: "museum",
          artwork,
          detail: "질문에서 직접 언급된 작품의 출처/박물관 맥락",
          extraLines: [`소장/출처 맥락: ${this.museumSourceForArtwork(artwork)}`],
        }));
      }
    }

    for (const [index, candidate] of candidates.entries()) {
      items.push({
        key: `knowledge-${index + 1}`,
        artworkId: candidate.artworkId,
        source: {
          type: candidate.sourceType === "museum" ? "museum" : "artwork_knowledge",
          title: candidate.artwork.title,
          artworkId: candidate.artworkId,
          sourceType: candidate.sourceType,
          detail: `ArtworkKnowledge.${candidate.sourceType}`,
        },
        text: candidate.text,
      });
    }

    return this.dedupeContextItems(items);
  }

  private artworkContextItem({
    key,
    sourceType,
    artwork,
    detail,
    extraLines = [],
  }: {
    key: string;
    sourceType: DocentSourceType;
    artwork: ArtworkForKnowledge;
    detail: string;
    extraLines?: string[];
  }): DocentContextItem {
    return {
      key,
      artworkId: artwork.id,
      source: {
        type: sourceType,
        title: artwork.title,
        artworkId: artwork.id,
        detail,
      },
      text: [
        `작품 ID: ${artwork.id}`,
        `제목: ${artwork.title}`,
        `작가: ${artwork.artist}`,
        `연도: ${artwork.year}`,
        `분류/태그: ${[...artwork.category, ...artwork.tags].join(", ")}`,
        `시대/지역: ${artwork.period} / ${artwork.region}`,
        `대표 색상 RGB: ${artwork.palette.join(", ")}`,
        ...extraLines,
      ].join("\n"),
    };
  }

  private async findKnowledgeCandidates(queryEmbedding: number[], artworkIds?: string[]) {
    const records = await this.prisma.artworkKnowledge.findMany({
      where: {
        sourceType: { in: [...KNOWLEDGE_SOURCE_TYPES] },
        ...(artworkIds?.length ? { artworkId: { in: artworkIds } } : {}),
      },
      include: { artwork: true },
    });
    return records
      .map((record) => {
        const vector = this.toVector(record.embedding);
        if (!vector) return null;
        return {
          record: record as KnowledgeCandidate,
          similarity: this.cosineSimilarity(queryEmbedding, vector),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, DOCENT_CONTEXT_LIMIT)
      .map((item) => item.record);
  }

  private async generateDocentAnswer({
    message,
    contextItems,
    intent,
    allowedSuggestedArtworkIds,
  }: {
    message: string;
    contextItems: DocentContextItem[];
    intent: DocentIntent;
    allowedSuggestedArtworkIds: string[];
  }) {
    const apiKey = this.openAiApiKey();
    const context = contextItems
      .map((item, index) => {
        return [
          `[${index + 1}] key=${item.key}`,
          `source=${item.source.type}`,
          item.artworkId ? `artworkId=${item.artworkId}` : "",
          item.source.sourceType ? `sourceType=${item.source.sourceType}` : "",
          item.text,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
    const prompt = [
      "You are ArtCatch's AI docent.",
      "Answer in Korean using only the provided ArtCatch service context.",
      "Do not invent artworks, missions, user collection items, museum facts, or availability outside the context.",
      "Recommendations must use only artwork ids from the allowed suggested artwork id list.",
      intent.daily
        ? "The user is asking about today's daily mission. Use only daily_mission context for today's mission answer and list the exact daily mission artworks from that context."
        : "",
      intent.collection
        ? "The user is asking about their collection. Use user_collection context first. If it is empty, say the collection is empty and do not pretend it has artworks."
        : "",
      "If the context is insufficient, clearly say that the current ArtCatch data is limited.",
      "Keep the answer concise: 3 to 6 sentences.",
      "Return strict JSON only.",
      "",
      `Allowed suggested artwork ids: ${allowedSuggestedArtworkIds.join(", ") || "(none)"}`,
      "",
      "ArtCatch service context:",
      context || "(no context)",
      "",
      `User question: ${message}`,
    ]
      .filter(Boolean)
      .join("\n");

    const response = await this.fetchWithTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.get<string>("OPENAI_DOCENT_MODEL") || this.config.get<string>("OPENAI_VISION_MODEL") || "gpt-5.4-mini",
          input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          text: {
            format: {
              type: "json_schema",
              name: "ai_docent_answer",
              strict: true,
              schema: DOCENT_RESPONSE_JSON_SCHEMA,
            },
          },
          max_output_tokens: 900,
        }),
      },
      OPENAI_DOCENT_TIMEOUT_MS,
    );
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(this.openAiErrorMessage(payload) || "openai_docent_failed");
    }

    const parsed = this.parseJsonObject(this.extractOutputText(payload));
    return {
      answer: typeof parsed.answer === "string" && parsed.answer.trim() ? parsed.answer.trim() : "답변을 만들지 못했어요.",
      suggestedArtworkIds: Array.isArray(parsed.suggestedArtworkIds)
        ? parsed.suggestedArtworkIds.filter((id): id is string => typeof id === "string")
        : [],
    };
  }

  private async findMentionedArtworks(message: string) {
    const normalizedMessage = this.normalizeText(message);
    if (!normalizedMessage) return [];

    const artworks = await this.prisma.artwork.findMany({
      where: {
        id: { notIn: REMOVED_ARTWORK_IDS },
        image: { not: null },
      },
      orderBy: { title: "asc" },
    });
    return artworks
      .filter((artwork) => {
        const normalizedTitle = this.normalizeText(artwork.title);
        const normalizedId = this.normalizeText(artwork.id);
        return (
          (normalizedTitle.length >= 2 && normalizedMessage.includes(normalizedTitle)) ||
          (normalizedId.length >= 3 && normalizedMessage.includes(normalizedId))
        );
      })
      .sort((left, right) => right.title.length - left.title.length)
      .slice(0, DOCENT_DYNAMIC_CONTEXT_LIMIT)
      .map((artwork) => withLocalArtworkImage(artwork) as ArtworkForKnowledge);
  }

  private async userCollectionArtworks(userId: string) {
    const [collections, purchases] = await Promise.all([
      this.prisma.collectionEntry.findMany({
        where: { userId },
        include: { artwork: true },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.purchase.findMany({
        where: { userId },
        include: { artwork: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const items: CollectionArtwork[] = [
      ...collections.map((entry) => ({
        artwork: withLocalArtworkImage(entry.artwork) as ArtworkForKnowledge,
        sourceLabel: entry.source === CollectionSource.MISSION ? "미션 수집" : "일반 수집",
        createdAt: entry.createdAt,
      })),
      ...purchases.map((purchase) => ({
        artwork: withLocalArtworkImage(purchase.artwork) as ArtworkForKnowledge,
        sourceLabel: "포인트 상점 구매",
        createdAt: purchase.createdAt,
      })),
    ];
    const byArtworkId = new Map<string, CollectionArtwork>();
    for (const item of items) {
      if (REMOVED_ARTWORK_IDS.includes(item.artwork.id) || !item.artwork.image) continue;
      if (!byArtworkId.has(item.artwork.id)) byArtworkId.set(item.artwork.id, item);
    }
    return [...byArtworkId.values()];
  }

  private allowedSuggestedArtworkIds({
    intent,
    dailyArtworks,
    collectionArtworks,
    mentionedArtworks,
    candidates,
    contextItems,
  }: {
    intent: DocentIntent;
    dailyArtworks: ArtworkForKnowledge[];
    collectionArtworks: CollectionArtwork[];
    mentionedArtworks: ArtworkForKnowledge[];
    candidates: KnowledgeCandidate[];
    contextItems: DocentContextItem[];
  }) {
    if (intent.daily) return dailyArtworks.map((artwork) => artwork.id);

    const ids = [
      ...(intent.collection ? collectionArtworks.map((item) => item.artwork.id) : []),
      ...mentionedArtworks.map((artwork) => artwork.id),
      ...candidates.map((candidate) => candidate.artworkId),
      ...contextItems.flatMap((item) => (item.artworkId ? [item.artworkId] : [])),
    ];
    return Array.from(new Set(ids)).slice(0, DOCENT_CONTEXT_LIMIT + DOCENT_DYNAMIC_CONTEXT_LIMIT);
  }

  private normalizeSuggestedArtworkIds(ids: string[], allowedSuggestedArtworkIds: string[]) {
    const allowed = Array.from(new Set(allowedSuggestedArtworkIds));
    const selected = ids.filter((id) => allowed.includes(id));
    for (const id of allowed) {
      if (selected.length >= DOCENT_SUGGESTION_LIMIT) break;
      if (!selected.includes(id)) selected.push(id);
    }
    return selected.slice(0, DOCENT_SUGGESTION_LIMIT);
  }

  private sourcesForResponse(contextItems: DocentContextItem[], suggestedArtworkIds: string[], intent: DocentIntent) {
    if (intent.daily) {
      return this.dedupeSources(contextItems.filter((item) => item.source.type === "daily_mission").map((item) => item.source)).slice(
        0,
        DOCENT_SOURCE_LIMIT,
      );
    }

    const preferred = contextItems.filter((item) => {
      if (intent.collection && item.source.type === "user_collection") return true;
      if (intent.museum && item.source.type === "museum") return true;
      return item.artworkId ? suggestedArtworkIds.includes(item.artworkId) : false;
    });
    const fallback = contextItems.filter((item) => !preferred.includes(item));
    const sources = [...preferred, ...fallback].map((item) => item.source);
    return this.dedupeSources(sources).slice(0, DOCENT_SOURCE_LIMIT);
  }

  private dedupeContextItems(items: DocentContextItem[]) {
    const seen = new Set<string>();
    const deduped: DocentContextItem[] = [];
    for (const item of items) {
      const key = `${item.source.type}:${item.artworkId ?? item.key}:${item.source.sourceType ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    return deduped;
  }

  private dedupeSources(sources: DocentSource[]) {
    const seen = new Set<string>();
    const deduped: DocentSource[] = [];
    for (const source of sources) {
      const key = `${source.type}:${source.artworkId ?? source.title}:${source.sourceType ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(source);
    }
    return deduped;
  }

  private museumSourceForArtwork(artwork: ArtworkForKnowledge) {
    const image = artwork.image || "";
    if (image.includes("artic.edu")) return "Art Institute of Chicago 공개 컬렉션 데이터/이미지";
    if (image.includes("clevelandart.org")) return "Cleveland Museum of Art 공개 컬렉션 데이터/이미지";
    if (image.startsWith("/artworks/")) return "ArtCatch 앱에 포함된 로컬 대표 작품 이미지";
    return "ArtCatch 작품 데이터베이스";
  }

  private normalizeText(value: string) {
    return value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s"'`‘’“”.,!?()[\]{}:;·—_-]+/g, "");
  }

  private async createEmbeddings(texts: string[]) {
    const apiKey = this.openAiApiKey();
    const response = await this.fetchWithTimeout(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.get<string>("OPENAI_EMBEDDING_MODEL") || "text-embedding-3-small",
          input: texts,
        }),
      },
      OPENAI_EMBEDDING_TIMEOUT_MS,
    );
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(this.openAiErrorMessage(payload) || "openai_embedding_failed");
    }

    const data = Array.isArray(payload.data) ? payload.data : [];
    return texts.map((_, index) => {
      const embedding = (data[index] as { embedding?: unknown } | undefined)?.embedding;
      const vector = this.toVector(embedding);
      if (!vector) throw new ServiceUnavailableException("openai_embedding_parse_failed");
      return vector;
    });
  }

  private openAiApiKey() {
    const apiKey = this.config.get<string>("OPENAI_API_KEY");
    if (!apiKey) throw new ServiceUnavailableException("openai_api_key_required");
    return apiKey;
  }

  private async fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ServiceUnavailableException("openai_timeout");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toVector(value: unknown) {
    if (!Array.isArray(value)) return null;
    const vector = value.map((item) => Number(item));
    return vector.length && vector.every((item) => Number.isFinite(item)) ? vector : null;
  }

  private cosineSimilarity(left: number[], right: number[]) {
    const length = Math.min(left.length, right.length);
    if (!length) return 0;

    let dot = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;
    for (let index = 0; index < length; index += 1) {
      dot += left[index] * right[index];
      leftMagnitude += left[index] * left[index];
      rightMagnitude += right[index] * right[index];
    }
    if (!leftMagnitude || !rightMagnitude) return 0;
    return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
  }

  private extractOutputText(payload: Record<string, unknown>) {
    if (typeof payload.output_text === "string") return payload.output_text;

    const parts: string[] = [];
    const output = Array.isArray(payload.output) ? payload.output : [];
    for (const item of output) {
      const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [];
      for (const chunk of content) {
        const text = (chunk as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("\n").trim();
  }

  private parseJsonObject(text: string) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new ServiceUnavailableException("openai_docent_parse_failed");
      return JSON.parse(match[0]) as Record<string, unknown>;
    }
  }

  private openAiErrorMessage(payload: Record<string, unknown>) {
    const error = payload.error as { message?: unknown } | undefined;
    return typeof error?.message === "string" ? error.message : "";
  }
}
