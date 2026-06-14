import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { REMOVED_ARTWORK_IDS, withLocalArtworkImage } from "../artworks/image-overrides";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../prisma.service";
import { AskDocentDto } from "./dto";

const DOCENT_CONTEXT_LIMIT = 8;
const DOCENT_SUGGESTION_LIMIT = 3;
const OPENAI_EMBEDDING_TIMEOUT_MS = 20_000;
const OPENAI_DOCENT_TIMEOUT_MS = 45_000;
const KNOWLEDGE_SOURCE_TYPES = ["metadata", "mission_hint"] as const;

const DOCENT_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "Korean answer grounded in the provided artwork context.",
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

@Injectable()
export class AiDocentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  async chat(dto: AskDocentDto, cookieHeader?: string) {
    await this.auth.requireUserFromCookie(cookieHeader);

    const message = dto.message.trim();
    await this.ensureArtworkKnowledge();

    const queryEmbedding = (await this.createEmbeddings([message]))[0];
    const candidates = await this.findKnowledgeCandidates(queryEmbedding);
    const response = await this.generateDocentAnswer({ message, candidates });
    const suggestedArtworkIds = this.normalizeSuggestedArtworkIds(response.suggestedArtworkIds, candidates);
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
    ];
  }

  private async findKnowledgeCandidates(queryEmbedding: number[]) {
    const records = await this.prisma.artworkKnowledge.findMany({
      where: { sourceType: { in: [...KNOWLEDGE_SOURCE_TYPES] } },
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

  private async generateDocentAnswer({ message, candidates }: { message: string; candidates: KnowledgeCandidate[] }) {
    const apiKey = this.openAiApiKey();
    const context = candidates
      .map((candidate, index) => {
        return [
          `[${index + 1}] artworkId=${candidate.artworkId}`,
          `sourceType=${candidate.sourceType}`,
          candidate.text,
        ].join("\n");
      })
      .join("\n\n");
    const prompt = [
      "You are ArtCatch's AI docent.",
      "Answer in Korean using only the provided artwork knowledge context.",
      "If the user asks for recommendations, suggest artworks from the context and explain why they fit.",
      "If the context is insufficient, say that the current collection data is limited and answer cautiously.",
      "Keep the answer concise: 3 to 6 sentences.",
      "Return strict JSON only.",
      "",
      "Artwork knowledge context:",
      context,
      "",
      `User question: ${message}`,
    ].join("\n");

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
          max_output_tokens: 800,
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

  private normalizeSuggestedArtworkIds(ids: string[], candidates: KnowledgeCandidate[]) {
    const candidateIds = Array.from(new Set(candidates.map((candidate) => candidate.artworkId)));
    const selected = ids.filter((id) => candidateIds.includes(id));
    for (const id of candidateIds) {
      if (selected.length >= DOCENT_SUGGESTION_LIMIT) break;
      if (!selected.includes(id)) selected.push(id);
    }
    return selected.slice(0, DOCENT_SUGGESTION_LIMIT);
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
