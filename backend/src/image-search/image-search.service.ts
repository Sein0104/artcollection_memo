import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { REMOVED_ARTWORK_IDS, withLocalArtworkImage } from "../artworks/image-overrides";
import { isPgVectorUnavailable, toPgVectorLiteral } from "../rag/pgvector";
import { PrismaService } from "../prisma.service";
import { ClipImageEmbeddingService } from "./clip-image-embedding.service";
import { SearchSimilarImageDto } from "./dto";

const IMAGE_SEARCH_CANDIDATE_LIMIT = 10;
const IMAGE_SEARCH_RERANK_LIMIT = 5;
const OPENAI_IMAGE_EXPLANATION_TIMEOUT_MS = 45_000;

const IMAGE_MATCH_RERANK_JSON_SCHEMA = {
  type: "object",
  properties: {
    selectedArtworkId: { type: "string" },
    rankedArtworkIds: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    similarParts: { type: "array", items: { type: "string" } },
    differentParts: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["selectedArtworkId", "rankedArtworkIds", "summary", "similarParts", "differentParts", "confidence"],
  additionalProperties: false,
};

type ArtworkForResponse = {
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

type PgVectorImageRow = {
  artworkId: string;
  image: string | null;
  similarity: number;
  artworkTitle: string;
  artworkArtist: string;
  artworkYear: string;
  artworkOrigin: string;
  artworkPeriod: string;
  artworkRegion: string;
  artworkCategory: string[];
  artworkTags: string[];
  artworkPalette: number[];
  artworkImage: string | null;
  artworkPremium: boolean;
  artworkCost: number;
};

type CountRow = {
  count: number | bigint;
};

type JsonImageRow = PgVectorImageRow & {
  embedding: unknown;
};

type ImageSearchMatch = {
  similarity: number;
  artwork: ArtworkForResponse;
};

type ImageMatchExplanation = {
  summary: string;
  similarParts: string[];
  differentParts: string[];
  confidence: "high" | "medium" | "low";
};

type ImageMatchRerankResult = ImageMatchExplanation & {
  selectedArtworkId: string;
  rankedArtworkIds: string[];
};

@Injectable()
export class ImageSearchService {
  private pgVectorReadDisabled = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clip: ClipImageEmbeddingService,
    private readonly config: ConfigService,
  ) {}

  async status() {
    const removedPlaceholders = REMOVED_ARTWORK_IDS.map((_, index) => `$${index + 1}`).join(", ");
    const removedFilter = REMOVED_ARTWORK_IDS.length ? `AND "id" NOT IN (${removedPlaceholders})` : "";
    const [artworkRows, indexedRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<CountRow[]>(
        `SELECT COUNT(*)::int AS "count" FROM "Artwork" WHERE "image" IS NOT NULL ${removedFilter}`,
        ...REMOVED_ARTWORK_IDS,
      ),
      this.prisma.$queryRawUnsafe<CountRow[]>(
        `SELECT COUNT(*)::int AS "count" FROM "ArtworkImageEmbedding" WHERE "model" = $1`,
        this.clip.modelName(),
      ),
    ]);
    const artworkCount = this.countFromRows(artworkRows);
    const indexedCount = this.countFromRows(indexedRows);
    return {
      model: this.clip.modelName(),
      dimensions: this.clip.dimensions(),
      artworkCount,
      indexedCount,
      ready: indexedCount > 0,
    };
  }

  async similar(dto: SearchSimilarImageDto) {
    const queryEmbedding = await this.clip.embedDataUrl(dto.imageDataUrl);
    const status = await this.status();
    const matches = await this.findSimilar(queryEmbedding);
    const reranked = await this.rerankMatches(dto.imageDataUrl, matches);

    return {
      ...status,
      bestMatch: reranked.bestMatch,
      explanation: reranked.explanation,
      matches: this.orderMatches(reranked.bestMatch, matches, reranked.rankedArtworkIds),
      candidateCount: matches.length,
      rankedArtworkIds: reranked.rankedArtworkIds,
      reranked: reranked.reranked,
    };
  }

  private async findSimilar(queryEmbedding: number[]): Promise<ImageSearchMatch[]> {
    const pgVectorMatches = await this.findSimilarWithPgVector(queryEmbedding);
    if (pgVectorMatches.length) return pgVectorMatches;
    return this.findSimilarWithJson(queryEmbedding);
  }

  private async rerankMatches(userImageDataUrl: string, matches: ImageSearchMatch[]) {
    const fallback = matches[0] ?? null;
    if (!fallback) {
      return { bestMatch: null, explanation: null, rankedArtworkIds: [], reranked: false };
    }

    try {
      const result = await this.rerankMatchesWithOpenAI(userImageDataUrl, matches);
      const selected = matches.find((match) => match.artwork.id === result.selectedArtworkId) ?? fallback;
      return {
        bestMatch: selected,
        explanation: this.normalizeRerankExplanation(result),
        rankedArtworkIds: result.rankedArtworkIds,
        reranked: selected.artwork.id !== fallback.artwork.id || result.rankedArtworkIds.length > 0,
      };
    } catch {
      return {
        bestMatch: fallback,
        explanation: {
          summary: "CLIP 후보는 찾았지만, Vision 재랭킹을 완료하지 못해 CLIP 기준 1순위를 표시합니다.",
          similarParts: [],
          differentParts: [],
          confidence: "low" as const,
        },
        rankedArtworkIds: [fallback.artwork.id],
        reranked: false,
      };
    }
  }

  private async rerankMatchesWithOpenAI(userImageDataUrl: string, matches: ImageSearchMatch[]): Promise<ImageMatchRerankResult> {
    const apiKey = this.config.get<string>("OPENAI_API_KEY");
    if (!apiKey) throw new ServiceUnavailableException("openai_api_key_required");

    const candidates = await this.rerankCandidates(matches);
    if (!candidates.length) throw new ServiceUnavailableException("image_rerank_candidates_empty");

    const model = this.config.get<string>("OPENAI_VISION_MODEL") || "gpt-5.4-mini";
    const prompt = [
      "You are reranking artwork image-search results for ArtCatch.",
      "Image 1 is the user's uploaded photo. The following candidate artwork images were retrieved by local CLIP image embeddings from a pgvector database.",
      "Choose the single candidate that is most visually similar to the uploaded photo.",
      "Do not simply choose the highest CLIP score. CLIP score is only a retrieval hint.",
      "Prioritize visible composition, dominant shapes, subject placement, pose, color palette, light, texture, and mood.",
      "If every candidate is weak, still choose the closest one, but set confidence to low and say the match is weak.",
      "Return Korean only except exact artwork IDs.",
      "selectedArtworkId must exactly match one candidate artworkId.",
      "rankedArtworkIds should list the candidate IDs from most to least visually similar.",
      "summary: one short Korean paragraph explaining why the selected artwork won.",
      "similarParts: 2-4 concrete visual similarities between the user photo and the selected artwork.",
      "differentParts: 2-4 concrete visual differences. Be honest if the selected match is only loosely related.",
      "",
      "Candidates:",
      candidates
        .map(({ match }, index) =>
          [
            `${index + 1}. artworkId=${match.artwork.id}`,
            `title=${match.artwork.title}`,
            `artist=${match.artwork.artist}`,
            `year=${match.artwork.year}`,
            `clipSimilarity=${match.similarity}`,
            `tags=${(match.artwork.tags ?? []).join(", ")}`,
          ].join(" | "),
        )
        .join("\n"),
    ].join("\n");

    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: prompt },
      { type: "input_text", text: "Image 1: user uploaded photo." },
      { type: "input_image", image_url: userImageDataUrl, detail: "high" },
    ];

    candidates.forEach(({ match, imageDataUrl }, index) => {
      content.push({
        type: "input_text",
        text: `Candidate ${index + 1}: artworkId=${match.artwork.id}, title=${match.artwork.title}, clipSimilarity=${match.similarity}.`,
      });
      content.push({ type: "input_image", image_url: imageDataUrl, detail: "low" });
    });

    const response = await this.fetchWithTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: [{ role: "user", content }],
          text: {
            format: {
              type: "json_schema",
              name: "image_match_rerank",
              strict: true,
              schema: IMAGE_MATCH_RERANK_JSON_SCHEMA,
            },
          },
          max_output_tokens: 1100,
        }),
      },
      OPENAI_IMAGE_EXPLANATION_TIMEOUT_MS,
    );

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(this.openAiErrorMessage(payload) || "openai_vision_failed");
    }

    return this.normalizeRerankResult(this.parseJsonObject(this.extractOutputText(payload)), candidates.map(({ match }) => match.artwork.id));
  }

  private async rerankCandidates(matches: ImageSearchMatch[]) {
    const candidates: Array<{ match: ImageSearchMatch; imageDataUrl: string }> = [];
    for (const match of matches.slice(0, IMAGE_SEARCH_RERANK_LIMIT)) {
      if (!match.artwork.image) continue;
      try {
        candidates.push({ match, imageDataUrl: await this.clip.artworkImageToDataUrl(match.artwork.image) });
      } catch {
        // Skip candidate images that cannot be loaded; CLIP fallback still works.
      }
    }
    return candidates;
  }

  private async findSimilarWithPgVector(queryEmbedding: number[]) {
    if (this.pgVectorReadDisabled) return [];

    const vectorLiteral = toPgVectorLiteral(queryEmbedding);
    if (!vectorLiteral) return [];

    const params: unknown[] = [vectorLiteral, this.clip.modelName()];
    const removedFilter = REMOVED_ARTWORK_IDS.length
      ? `AND a."id" NOT IN (${REMOVED_ARTWORK_IDS.map((id) => {
          params.push(id);
          return `$${params.length}`;
        }).join(", ")})`
      : "";

    try {
      const rows = await this.prisma.$queryRawUnsafe<PgVectorImageRow[]>(
        `
          SELECT
            e."artworkId",
            e."image",
            (1 - (e."embeddingVector" <=> $1::vector)) AS "similarity",
            a."title" AS "artworkTitle",
            a."artist" AS "artworkArtist",
            a."year" AS "artworkYear",
            a."origin" AS "artworkOrigin",
            a."period" AS "artworkPeriod",
            a."region" AS "artworkRegion",
            a."category" AS "artworkCategory",
            a."tags" AS "artworkTags",
            a."palette" AS "artworkPalette",
            a."image" AS "artworkImage",
            a."premium" AS "artworkPremium",
            a."cost" AS "artworkCost"
          FROM "ArtworkImageEmbedding" e
          JOIN "Artwork" a ON a."id" = e."artworkId"
          WHERE e."model" = $2
            AND e."embeddingVector" IS NOT NULL
            ${removedFilter}
          ORDER BY e."embeddingVector" <=> $1::vector
          LIMIT ${IMAGE_SEARCH_CANDIDATE_LIMIT}
        `,
        ...params,
      );

      return rows.map((row) => ({
        similarity: this.roundSimilarity(Number(row.similarity)),
        artwork: this.toArtwork({
          id: row.artworkId,
          title: row.artworkTitle,
          artist: row.artworkArtist,
          year: row.artworkYear,
          origin: row.artworkOrigin,
          period: row.artworkPeriod,
          region: row.artworkRegion,
          category: row.artworkCategory ?? [],
          tags: row.artworkTags ?? [],
          palette: row.artworkPalette ?? [],
          image: row.artworkImage,
          premium: row.artworkPremium,
          cost: row.artworkCost,
        }),
      }));
    } catch (error) {
      if (isPgVectorUnavailable(error)) {
        this.pgVectorReadDisabled = true;
        return [];
      }
      throw error;
    }
  }

  private async findSimilarWithJson(queryEmbedding: number[]) {
    const params: unknown[] = [this.clip.modelName()];
    const removedFilter = REMOVED_ARTWORK_IDS.length
      ? `AND a."id" NOT IN (${REMOVED_ARTWORK_IDS.map((id) => {
          params.push(id);
          return `$${params.length}`;
        }).join(", ")})`
      : "";

    const records = await this.prisma.$queryRawUnsafe<JsonImageRow[]>(
      `
        SELECT
          e."artworkId",
          e."image",
          e."embedding",
          0::float AS "similarity",
          a."title" AS "artworkTitle",
          a."artist" AS "artworkArtist",
          a."year" AS "artworkYear",
          a."origin" AS "artworkOrigin",
          a."period" AS "artworkPeriod",
          a."region" AS "artworkRegion",
          a."category" AS "artworkCategory",
          a."tags" AS "artworkTags",
          a."palette" AS "artworkPalette",
          a."image" AS "artworkImage",
          a."premium" AS "artworkPremium",
          a."cost" AS "artworkCost"
        FROM "ArtworkImageEmbedding" e
        JOIN "Artwork" a ON a."id" = e."artworkId"
        WHERE e."model" = $1
          ${removedFilter}
      `,
      ...params,
    );

    return records
      .map((record) => {
        const embedding = this.toVector(record.embedding);
        if (!embedding) return null;
        return {
          similarity: this.roundSimilarity(this.cosineSimilarity(queryEmbedding, embedding)),
          artwork: this.toArtwork({
            id: record.artworkId,
            title: record.artworkTitle,
            artist: record.artworkArtist,
            year: record.artworkYear,
            origin: record.artworkOrigin,
            period: record.artworkPeriod,
            region: record.artworkRegion,
            category: record.artworkCategory ?? [],
            tags: record.artworkTags ?? [],
            palette: record.artworkPalette ?? [],
            image: record.artworkImage,
            premium: record.artworkPremium,
            cost: record.artworkCost,
          }),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, IMAGE_SEARCH_CANDIDATE_LIMIT);
  }

  private orderMatches(bestMatch: ImageSearchMatch | null, matches: ImageSearchMatch[], rankedArtworkIds: string[]) {
    const byId = new Map(matches.map((match) => [match.artwork.id, match]));
    const ordered: ImageSearchMatch[] = [];
    const push = (id: string) => {
      const match = byId.get(id);
      if (!match || ordered.some((item) => item.artwork.id === id)) return;
      ordered.push(match);
    };

    if (bestMatch) push(bestMatch.artwork.id);
    rankedArtworkIds.forEach(push);
    matches.forEach((match) => push(match.artwork.id));
    return ordered;
  }

  private toArtwork(artwork: ArtworkForResponse) {
    return withLocalArtworkImage({
      id: artwork.id,
      title: artwork.title,
      artist: artwork.artist,
      year: artwork.year,
      origin: artwork.origin,
      period: artwork.period,
      region: artwork.region,
      category: artwork.category ?? [],
      tags: artwork.tags ?? [],
      palette: artwork.palette ?? [],
      image: artwork.image,
      premium: artwork.premium,
      cost: artwork.cost,
    });
  }

  private toVector(value: unknown): number[] | null {
    if (typeof value === "string") {
      try {
        return this.toVector(JSON.parse(value) as unknown);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(value)) return null;
    const vector = value.map(Number).filter((item) => Number.isFinite(item));
    return vector.length ? vector : null;
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

  private openAiErrorMessage(payload: Record<string, unknown>) {
    const error = payload.error as { message?: unknown } | undefined;
    return typeof error?.message === "string" ? error.message : "";
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
      if (!match) throw new ServiceUnavailableException("openai_vision_parse_failed");
      return JSON.parse(match[0]) as Record<string, unknown>;
    }
  }

  private normalizeRerankResult(parsed: Record<string, unknown>, candidateIds: string[]): ImageMatchRerankResult {
    const parsedSelectedId = this.stringValue(parsed.selectedArtworkId);
    const selectedArtworkId = candidateIds.includes(parsedSelectedId) ? parsedSelectedId : candidateIds[0] || "";
    const parsedRankedIds = this.stringArray(parsed.rankedArtworkIds, []).filter((id) => candidateIds.includes(id));
    const rankedArtworkIds = this.uniqueStrings([selectedArtworkId, ...parsedRankedIds, ...candidateIds]).filter(Boolean);
    return {
      selectedArtworkId,
      rankedArtworkIds,
      ...this.normalizeExplanation(parsed),
    };
  }

  private normalizeRerankExplanation(result: ImageMatchRerankResult): ImageMatchExplanation {
    return {
      summary: result.summary,
      similarParts: result.similarParts,
      differentParts: result.differentParts,
      confidence: result.confidence,
    };
  }

  private normalizeExplanation(parsed: Record<string, unknown>): ImageMatchExplanation {
    const confidence = parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low" ? parsed.confidence : "medium";
    return {
      summary: this.stringValue(parsed.summary) || "가장 가까운 작품을 기준으로 이미지의 구도와 분위기를 비교했습니다.",
      similarParts: this.stringArray(parsed.similarParts, ["색감, 구도, 분위기 중 일부가 비슷하게 감지되었습니다."]),
      differentParts: this.stringArray(parsed.differentParts, ["세부 피사체나 배경은 다를 수 있습니다."]),
      confidence,
    };
  }

  private stringArray(value: unknown, fallback: string[]) {
    const items = Array.isArray(value)
      ? value.map((item) => this.stringValue(item)).filter((item): item is string => Boolean(item))
      : [];
    return items.length ? items.slice(0, 4) : fallback;
  }

  private stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
  }

  private uniqueStrings(values: string[]) {
    return Array.from(new Set(values));
  }

  private countFromRows(rows: CountRow[]) {
    const value = rows[0]?.count ?? 0;
    return typeof value === "bigint" ? Number(value) : Number(value);
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

  private roundSimilarity(value: number) {
    return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
  }
}
