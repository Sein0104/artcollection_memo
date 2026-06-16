import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CollectionSource } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { addDaysToDateKey, missionDateRangeForKey, yyyyMmDd } from "../common/date";
import { PrismaService } from "../prisma.service";
import { AuthService } from "../auth/auth.service";
import { REMOVED_ARTWORK_IDS, withLocalArtworkImage } from "../artworks/image-overrides";
import { isPgVectorUnavailable, toPgVectorLiteral } from "../rag/pgvector";
import { AnalyzeMissionDto, CompleteMissionDto } from "./dto";

const MISSION_PASS_THRESHOLD = 62;
const EMBEDDING_SIMILARITY_THRESHOLD = 0.74;
const DAILY_MISSION_COUNT = 3;
const RECENT_MISSION_EXCLUSION_DAYS = 3;
const MISSION_ROTATION_ANCHOR_DATE_KEY = "2026-01-01";
const MISSION_IMAGE_DATA_URL_MAX_LENGTH = 4 * 1024 * 1024;
const MISSION_IMAGE_BYTES_MAX = 3 * 1024 * 1024;
const REFERENCE_IMAGE_BYTES_MAX = 8 * 1024 * 1024;
const REFERENCE_IMAGE_FETCH_TIMEOUT_MS = 20_000;
const OPENAI_VISION_TIMEOUT_MS = 60_000;
const OPENAI_EMBEDDING_TIMEOUT_MS = 20_000;
const MISSION_IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/=]+)$/i;
const MISSION_ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    score: {
      type: "number",
      description: "Similarity score from 0 to 100.",
    },
    passed: {
      type: "boolean",
      description: "Whether score meets the pass threshold.",
    },
    feedback: {
      type: "string",
      description: "Korean feedback in one concise, actionable sentence.",
    },
    analysisText: {
      type: "string",
      description: "Korean summary of composition, color, distance, pose, and lighting reasons.",
    },
    aspects: {
      type: "object",
      properties: {
        composition: { type: "string" },
        color: { type: "string" },
        distance: { type: "string" },
        pose: { type: "string" },
        lighting: { type: "string" },
      },
      required: ["composition", "color", "distance", "pose", "lighting"],
      additionalProperties: false,
    },
  },
  required: ["score", "passed", "feedback", "analysisText", "aspects"],
  additionalProperties: false,
} as const;

type MissionMode = "capture" | "pose";

type MissionAnalysisResult = {
  score: number;
  passed: boolean;
  feedback: string;
  coachTip?: string;
  analysisText?: string;
  aspects?: Record<string, string>;
};

type PgVectorCoachRow = {
  artworkId: string;
  artworkTitle: string;
  feedback: string;
  analysisText: string;
  passed: boolean;
  similarity: number;
};

@Injectable()
export class MissionsService {
  private pgVectorReadDisabled = false;
  private pgVectorWriteDisabled = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  async daily() {
    const artworks = await this.prisma.artwork.findMany({
      where: {
        premium: false,
        id: { notIn: REMOVED_ARTWORK_IDS },
        image: { not: null },
      },
      orderBy: { id: "asc" },
    });
    const dateKey = yyyyMmDd();
    return { dateKey, missions: this.pickDailyMissions(artworks.map(withLocalArtworkImage), dateKey) };
  }

  async complete(dto: CompleteMissionDto, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);
    await this.assertDailyMission(dto.artworkId);
    const missionKey = yyyyMmDd();
    const completionWhere = {
      userId_artworkId_missionKey: {
        userId: user.id,
        artworkId: dto.artworkId,
        missionKey,
      },
    };
    const collectionWhere = {
      userId_artworkId_source_missionKey: {
        userId: user.id,
        artworkId: dto.artworkId,
        source: CollectionSource.MISSION,
        missionKey,
      },
    };

    const alreadyCompleted = await this.prisma.missionCompletion.findUnique({ where: completionWhere });
    if (alreadyCompleted) return { state: await this.auth.userState(user.id) };

    const completedCount = await this.prisma.missionCompletion.count({ where: { userId: user.id, missionKey } });
    if (completedCount >= 3) throw new BadRequestException("daily_mission_limit");

    const passedAnalysis = await this.hasPassedMissionAnalysis({
      userId: user.id,
      artworkId: dto.artworkId,
      missionKey,
    });
    if (!passedAnalysis) throw new BadRequestException("mission_analysis_required");

    await this.prisma.$transaction([
      this.prisma.missionCompletion.create({
        data: {
          userId: user.id,
          artworkId: dto.artworkId,
          missionKey,
        },
      }),
      this.prisma.collectionEntry.upsert({
        where: collectionWhere,
        update: {},
        create: {
          userId: user.id,
          artworkId: dto.artworkId,
          source: CollectionSource.MISSION,
          missionKey,
        },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          points: { increment: 80 },
          totalEarnedPoints: { increment: 80 },
        },
      }),
    ]);
    return { state: await this.auth.userState(user.id) };
  }

  async analyze(dto: AnalyzeMissionDto, cookieHeader?: string): Promise<MissionAnalysisResult> {
    const user = await this.auth.requireUserFromCookie(cookieHeader);
    await this.assertDailyMission(dto.artworkId);
    await this.assertMissionImageDataUrl({
      userId: user.id,
      artworkId: dto.artworkId,
      imageDataUrl: dto.imageDataUrl,
    });

    const artwork = await this.prisma.artwork.findFirst({
      where: {
        AND: [{ id: dto.artworkId }, { id: { notIn: REMOVED_ARTWORK_IDS } }],
        image: { not: null },
      },
    });
    if (!artwork) throw new BadRequestException("artwork_not_available");

    const reference = withLocalArtworkImage(artwork);
    if (!reference.image) throw new BadRequestException("artwork_image_missing");

    const mode: MissionMode = "pose";
    const attempt = await this.recordMissionAnalysisAttempt({
      userId: user.id,
      artworkId: reference.id,
      status: "started",
    });

    try {
      const referenceImageUrl = await this.artworkImageToModelInput(reference.image);
      const analysis = await this.analyzeWithOpenAI({
        artwork: reference,
        mode,
        referenceImageUrl,
        userImageDataUrl: dto.imageDataUrl,
      });
      const analysisText = this.analysisToRetrievalText({ artwork: reference, mode, analysis });
      const embedding = await this.createEmbeddingSafely(analysisText);
      const coachTip = embedding ? await this.findCoachTip({ artworkId: reference.id, mode, embedding }) : "";

      await this.storeMissionAnalysis({
        userId: user.id,
        artworkId: reference.id,
        mode,
        analysis: { ...analysis, analysisText, coachTip },
        embedding,
      });
      await this.updateMissionAnalysisAttempt(attempt.id, "succeeded");

      return {
        score: analysis.score,
        passed: analysis.passed,
        feedback: analysis.feedback,
        coachTip,
      };
    } catch (error) {
      await this.updateMissionAnalysisAttempt(attempt.id, "failed", this.analysisFailureReason(error));
      throw error;
    }
  }

  private pickDailyMissions<T extends { id: string }>(artworks: T[], dateKey: string) {
    if (artworks.length <= DAILY_MISSION_COUNT) return artworks;
    if (dateKey < MISSION_ROTATION_ANCHOR_DATE_KEY) {
      return this.pickDailyMissionsForDate(artworks, dateKey, new Set());
    }

    const selections = new Map<string, T[]>();
    for (
      let currentDateKey = MISSION_ROTATION_ANCHOR_DATE_KEY;
      currentDateKey <= dateKey;
      currentDateKey = addDaysToDateKey(currentDateKey, 1)
    ) {
      const recentlyUsedIds = new Set<string>();
      for (let dayOffset = 1; dayOffset <= RECENT_MISSION_EXCLUSION_DAYS; dayOffset += 1) {
        const previousDateKey = addDaysToDateKey(currentDateKey, -dayOffset);
        for (const mission of selections.get(previousDateKey) ?? []) {
          recentlyUsedIds.add(mission.id);
        }
      }
      selections.set(currentDateKey, this.pickDailyMissionsForDate(artworks, currentDateKey, recentlyUsedIds));
    }

    return selections.get(dateKey) ?? [];
  }

  private pickDailyMissionsForDate<T extends { id: string }>(artworks: T[], dateKey: string, excludedIds: Set<string>) {
    const missionCount = Math.min(DAILY_MISSION_COUNT, artworks.length);
    const eligible = artworks.filter((artwork) => !excludedIds.has(artwork.id));
    const selected = this.seededShuffle(eligible, dateKey).slice(0, missionCount);
    if (selected.length >= missionCount) return selected;

    const selectedIds = new Set(selected.map((artwork) => artwork.id));
    const fallback = this.seededShuffle(
      artworks.filter((artwork) => !selectedIds.has(artwork.id)),
      `${dateKey}:fallback`,
    );
    return [...selected, ...fallback].slice(0, missionCount);
  }

  private seededShuffle<T extends { id: string }>(items: T[], seed: string) {
    return items
      .map((item, index) => ({
        item,
        score: this.seededHash(`${seed}:${item.id}:${index}`),
      }))
      .sort((left, right) => left.score - right.score || left.item.id.localeCompare(right.item.id))
      .map(({ item }) => item);
  }

  private seededHash(input: string) {
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private async assertDailyMission(artworkId: string) {
    const { missions } = await this.daily();
    if (!missions.some((mission) => mission.id === artworkId)) {
      throw new BadRequestException("not_daily_mission");
    }
  }

  private async hasPassedMissionAnalysis({
    userId,
    artworkId,
    missionKey,
  }: {
    userId: string;
    artworkId: string;
    missionKey: string;
  }) {
    const { start, end } = missionDateRangeForKey(missionKey);
    const record = await this.prisma.missionAnalysisRecord.findFirst({
      where: {
        userId,
        artworkId,
        passed: true,
        createdAt: {
          gte: start,
          lt: end,
        },
      },
      select: { id: true },
    });
    return Boolean(record);
  }

  private async assertMissionImageDataUrl({
    userId,
    artworkId,
    imageDataUrl,
  }: {
    userId: string;
    artworkId: string;
    imageDataUrl: string;
  }) {
    if (imageDataUrl.length > MISSION_IMAGE_DATA_URL_MAX_LENGTH) {
      await this.blockMissionAnalysisAttempt({ userId, artworkId, reason: "mission_image_too_large" });
    }

    const match = imageDataUrl.match(MISSION_IMAGE_DATA_URL_PATTERN);
    if (!match) {
      return await this.blockMissionAnalysisAttempt({ userId, artworkId, reason: "mission_image_invalid_type" });
    }

    const base64 = match[2];
    if (base64.length % 4 !== 0) {
      return await this.blockMissionAnalysisAttempt({ userId, artworkId, reason: "mission_image_invalid" });
    }

    const byteLength = Buffer.byteLength(base64, "base64");
    if (byteLength > MISSION_IMAGE_BYTES_MAX) {
      return await this.blockMissionAnalysisAttempt({ userId, artworkId, reason: "mission_image_too_large" });
    }
  }

  private async blockMissionAnalysisAttempt({
    userId,
    artworkId,
    reason,
  }: {
    userId: string;
    artworkId: string;
    reason: string;
  }): Promise<never> {
    await this.recordMissionAnalysisAttempt({ userId, artworkId, status: "blocked", reason });
    throw new BadRequestException(reason);
  }

  private recordMissionAnalysisAttempt({
    userId,
    artworkId,
    status,
    reason,
  }: {
    userId: string;
    artworkId?: string;
    status: string;
    reason?: string;
  }) {
    return this.prisma.missionAnalysisAttempt.create({
      data: {
        userId,
        artworkId,
        status,
        reason,
      },
      select: { id: true },
    });
  }

  private async updateMissionAnalysisAttempt(id: string, status: string, reason?: string) {
    await this.prisma.missionAnalysisAttempt.update({
      where: { id },
      data: { status, reason },
    });
  }

  private analysisFailureReason(error: unknown) {
    if (error instanceof ServiceUnavailableException || error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === "string") return response;
      const message = (response as { message?: unknown }).message;
      if (typeof message === "string") return message;
      if (Array.isArray(message) && typeof message[0] === "string") return message[0];
    }
    if (error instanceof Error && error.message) return error.message.slice(0, 120);
    return "mission_analysis_failed";
  }

  private analysisToRetrievalText({
    artwork,
    mode,
    analysis,
  }: {
    artwork: { title: string; artist: string; year: string; tags: string[] };
    mode: MissionMode;
    analysis: MissionAnalysisResult;
  }) {
    const aspects = Object.entries(analysis.aspects ?? {})
      .map(([key, value]) => `${key}: ${value}`)
      .join(" / ");
    return [
      `mode: ${mode}`,
      `artwork: ${artwork.title}`,
      `artist: ${artwork.artist}`,
      `year: ${artwork.year}`,
      `tags: ${artwork.tags.join(", ")}`,
      `score: ${analysis.score}`,
      `passed: ${analysis.passed}`,
      `feedback: ${analysis.feedback}`,
      `analysis: ${analysis.analysisText ?? ""}`,
      `aspects: ${aspects}`,
    ].join("\n");
  }

  private async createEmbeddingSafely(text: string) {
    const apiKey = this.config.get<string>("OPENAI_API_KEY");
    if (!apiKey) return null;

    try {
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
            input: text,
          }),
        },
        OPENAI_EMBEDDING_TIMEOUT_MS,
      );
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) return null;

      const data = Array.isArray(payload.data) ? payload.data : [];
      const embedding = (data[0] as { embedding?: unknown } | undefined)?.embedding;
      return this.toVector(embedding);
    } catch {
      return null;
    }
  }

  private async findCoachTip({ artworkId, mode, embedding }: { artworkId: string; mode: MissionMode; embedding: number[] }) {
    const pgVectorTip = await this.findCoachTipWithPgVector({ artworkId, mode, embedding });
    if (pgVectorTip) return pgVectorTip;

    try {
      const records = await this.prisma.missionAnalysisRecord.findMany({
        where: { mode },
        orderBy: { createdAt: "desc" },
        take: 120,
        include: { artwork: true },
      });
      const candidates = records
        .filter((record) => !this.isUnhelpfulCoachRecord(record.feedback, record.analysisText))
        .map((record) => {
          const vector = this.toVector(record.embedding);
          if (!vector) return null;
          const artworkBoost = record.artworkId === artworkId ? 0.05 : 0;
          return { record, similarity: this.cosineSimilarity(embedding, vector) + artworkBoost };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .filter((item) => item.similarity >= EMBEDDING_SIMILARITY_THRESHOLD)
        .sort((left, right) => right.similarity - left.similarity);

      const best = candidates[0];
      if (!best) return "";

      const sameArtwork = best.record.artworkId === artworkId;
      const target = sameArtwork ? "이 작품" : `${best.record.artwork.title}`;
      const resultLabel = best.record.passed ? "좋은 점수" : "낮은 점수";
      const followUp = best.record.passed ? "이번 사진도 그 강점을 살려보세요." : "이번 사진도 그 부분을 먼저 조정해보세요.";
      return `미션 코치: ${target}의 비슷한 ${resultLabel} 기록에서는 "${this.trimSentence(best.record.feedback)}"라는 피드백이 있었어요. ${followUp}`;
    } catch {
      return "";
    }
  }

  private async findCoachTipWithPgVector({ artworkId, mode, embedding }: { artworkId: string; mode: MissionMode; embedding: number[] }) {
    if (this.pgVectorReadDisabled) return "";

    const vectorLiteral = toPgVectorLiteral(embedding);
    if (!vectorLiteral) return "";

    try {
      const rows = await this.prisma.$queryRawUnsafe<PgVectorCoachRow[]>(
        `
          SELECT
            r."artworkId",
            a."title" AS "artworkTitle",
            r."feedback",
            r."analysisText",
            r."passed",
            (1 - (r."embeddingVector" <=> $1::vector) + CASE WHEN r."artworkId" = $2 THEN 0.05 ELSE 0 END) AS "similarity"
          FROM "MissionAnalysisRecord" r
          JOIN "Artwork" a ON a."id" = r."artworkId"
          WHERE r."mode" = $3
            AND r."embeddingVector" IS NOT NULL
          ORDER BY r."embeddingVector" <=> $1::vector
          LIMIT 20
        `,
        vectorLiteral,
        artworkId,
        mode,
      );
      const best = rows
        .filter((row) => !this.isUnhelpfulCoachRecord(row.feedback, row.analysisText))
        .map((row) => ({ row, similarity: Number(row.similarity) }))
        .filter((item) => Number.isFinite(item.similarity) && item.similarity >= EMBEDDING_SIMILARITY_THRESHOLD)
        .sort((left, right) => right.similarity - left.similarity)[0];

      if (!best) return "";

      const sameArtwork = best.row.artworkId === artworkId;
      const target = sameArtwork ? "같은 작품" : best.row.artworkTitle;
      const resultLabel = best.row.passed ? "좋은 점수" : "낮은 점수";
      const followUp = best.row.passed ? "이번 사진도 그 강점을 살려보세요." : "이번 사진에서는 그 부분을 먼저 조정해보세요.";
      return `미션 코치: ${target}과 비슷한 ${resultLabel} 기록에서 "${this.trimSentence(best.row.feedback)}"라는 피드백이 있었어요. ${followUp}`;
    } catch (error) {
      if (isPgVectorUnavailable(error)) {
        this.pgVectorReadDisabled = true;
        return "";
      }
      throw error;
    }
  }

  private async storeMissionAnalysis({
    userId,
    artworkId,
    mode,
    analysis,
    embedding,
  }: {
    userId: string;
    artworkId: string;
    mode: MissionMode;
    analysis: MissionAnalysisResult;
    embedding: number[] | null;
  }) {
    const data: Record<string, unknown> = {
      userId,
      artworkId,
      mode,
      score: analysis.score,
      passed: analysis.passed,
      feedback: analysis.feedback,
      coachTip: analysis.coachTip ?? "",
      analysisText: analysis.analysisText ?? analysis.feedback,
    };
    if (analysis.aspects) data.aspects = analysis.aspects;
    if (embedding) data.embedding = embedding;

    const record = await this.prisma.missionAnalysisRecord.create({
      data: data as any,
      select: { id: true },
    });
    if (embedding) await this.storeMissionAnalysisPgVector(record.id, embedding);
  }

  private async storeMissionAnalysisPgVector(id: string, embedding: number[]) {
    if (this.pgVectorWriteDisabled) return;

    const vectorLiteral = toPgVectorLiteral(embedding);
    if (!vectorLiteral) return;

    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE "MissionAnalysisRecord" SET "embeddingVector" = $1::vector WHERE "id" = $2`,
        vectorLiteral,
        id,
      );
    } catch (error) {
      if (isPgVectorUnavailable(error)) {
        this.pgVectorWriteDisabled = true;
        return;
      }
      throw error;
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

  private trimSentence(text: string) {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length > 90 ? `${normalized.slice(0, 87)}...` : normalized;
  }

  private isUnhelpfulCoachRecord(feedback: string, analysisText: string) {
    const text = `${feedback} ${analysisText}`.toLowerCase();
    return text.includes("image 2") || text.includes("보이지") || text.includes("valid image") || text.includes("이미지 파일을 읽지");
  }

  private async analyzeWithOpenAI({
    artwork,
    mode,
    referenceImageUrl,
    userImageDataUrl,
  }: {
    artwork: { title: string; artist: string; year: string; tags: string[] };
    mode: MissionMode;
    referenceImageUrl: string;
    userImageDataUrl: string;
  }): Promise<MissionAnalysisResult> {
    const apiKey = this.config.get<string>("OPENAI_API_KEY");
    if (!apiKey) throw new ServiceUnavailableException("openai_api_key_required");

    const model = this.config.get<string>("OPENAI_VISION_MODEL") || "gpt-5.4-mini";
    const prompt = [
      "You are judging an ArtCatch photo mission.",
      "Compare image 1, the reference artwork, with image 2, the user's photo.",
      `Reference artwork: ${artwork.title} by ${artwork.artist}, ${artwork.year}.`,
      `Important visual tags: ${artwork.tags.join(", ")}.`,
      `Use this pass threshold: ${MISSION_PASS_THRESHOLD}.`,
      mode === "pose"
        ? [
            "The user is playing an approachable art-imitation mission, not doing forensic image matching.",
            "Be generous when the submitted photo clearly tries to imitate the artwork.",
            "Prioritize recognizable intent, core pose or gesture, main silhouette or dominant shape, subject placement, composition, color palette, lighting mood, and playful reinterpretation.",
            "Do not require the same background, museum setting, exact props, exact clothing, exact number of people, exact camera angle, or a direct photograph of the artwork. Treat those details as bonus points only.",
            "If at least two major elements are recognizable, such as pose/gesture, composition, color/mood, or main shape, the score should usually be at least the pass threshold.",
            "If one major element is strong and another is partially present, score around 50-61 rather than pushing it into the 30s.",
            "Reserve scores below 45 for photos that are mostly unrelated or missing the artwork's core visual idea.",
          ].join(" ")
        : "The user is trying to photograph a real scene or object that resembles the artwork. Score 0-100 by visual similarity: composition, subject placement, dominant shapes, colors, lighting, and mood.",
      "Return only strict JSON with this exact shape:",
      '{"score":72,"passed":true,"feedback":"Korean feedback in one concise, actionable sentence.","analysisText":"Korean summary of composition, color, distance, pose, and lighting reasons.","aspects":{"composition":"Korean note","color":"Korean note","distance":"Korean note","pose":"Korean note","lighting":"Korean note"}}',
      "If score is below the threshold, feedback must explain what to change in the next photo.",
      "analysisText and aspects must be useful for retrieving similar past success or failure patterns later.",
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
          model,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_text", text: "Reference artwork image:" },
                { type: "input_image", image_url: referenceImageUrl, detail: "high" },
                { type: "input_text", text: "User submitted photo:" },
                { type: "input_image", image_url: userImageDataUrl, detail: "high" },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "mission_analysis",
              strict: true,
              schema: MISSION_ANALYSIS_JSON_SCHEMA,
            },
          },
          max_output_tokens: 700,
        }),
      },
      OPENAI_VISION_TIMEOUT_MS,
    );

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(this.openAiErrorMessage(payload) || "openai_vision_failed");
    }

    const outputText = this.extractOutputText(payload);
    const parsed = this.parseAnalysisJson(outputText);
    return this.normalizeAnalysis(parsed);
  }

  private async artworkImageToModelInput(imagePath: string) {
    if (imagePath.startsWith("https://")) return this.remoteArtworkImageToDataUrl(imagePath);
    if (!imagePath.startsWith("/artworks/")) throw new BadRequestException("artwork_image_not_local");

    const workspaceRoot = process.cwd().endsWith("backend") ? resolve(process.cwd(), "..") : process.cwd();
    const publicRoot = resolve(workspaceRoot, "frontend", "public");
    const resolvedPath = resolve(publicRoot, imagePath.replace(/^\//, ""));
    if (!resolvedPath.startsWith(publicRoot)) throw new BadRequestException("artwork_image_not_local");

    const bytes = await readFile(resolvedPath);
    return `data:${this.mimeTypeFor(resolvedPath)};base64,${bytes.toString("base64")}`;
  }

  private async remoteArtworkImageToDataUrl(imageUrl: string) {
    const response = await this.fetchWithTimeout(
      imageUrl,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          Referer: new URL(imageUrl).origin,
        },
      },
      REFERENCE_IMAGE_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new ServiceUnavailableException(`artwork_image_download_failed_${response.status}`);
    }

    const mimeType = this.imageMimeTypeFromContentType(response.headers.get("content-type"));
    if (!mimeType) throw new ServiceUnavailableException("artwork_image_invalid_type");

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > REFERENCE_IMAGE_BYTES_MAX) throw new ServiceUnavailableException("artwork_image_too_large");

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > REFERENCE_IMAGE_BYTES_MAX) throw new ServiceUnavailableException("artwork_image_too_large");

    return `data:${mimeType};base64,${bytes.toString("base64")}`;
  }

  private imageMimeTypeFromContentType(contentType: string | null) {
    const mimeType = contentType?.split(";")[0]?.trim().toLowerCase();
    if (mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/webp") return mimeType;
    return "";
  }

  private mimeTypeFor(path: string) {
    const ext = extname(path).toLowerCase();
    if (ext === ".png") return "image/png";
    if (ext === ".webp") return "image/webp";
    return "image/jpeg";
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

  private parseAnalysisJson(text: string) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new ServiceUnavailableException("openai_vision_parse_failed");
      return JSON.parse(match[0]) as Record<string, unknown>;
    }
  }

  private normalizeAnalysis(parsed: Record<string, unknown>): MissionAnalysisResult {
    const rawScore = typeof parsed.score === "number" ? parsed.score : Number(parsed.score);
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
    const passed = typeof parsed.passed === "boolean" ? parsed.passed : score >= MISSION_PASS_THRESHOLD;
    const aspects = this.normalizeAspects(parsed.aspects);
    const analysisText =
      typeof parsed.analysisText === "string" && parsed.analysisText.trim()
        ? parsed.analysisText.trim()
        : Object.entries(aspects)
            .map(([key, value]) => `${key}: ${value}`)
            .join(" / ");
    const feedback =
      typeof parsed.feedback === "string" && parsed.feedback.trim()
        ? parsed.feedback.trim()
        : passed
          ? "작품의 분위기와 구도가 충분히 닮았어요."
          : "주요 색감, 구도, 피사체 위치가 더 비슷하게 보이도록 다시 찍어보세요.";

    return { score, passed, feedback, analysisText, aspects };
  }

  private normalizeAspects(value: unknown) {
    const fallback: Record<string, string> = {
      composition: "구도 판단 정보가 부족합니다.",
      color: "색감 판단 정보가 부족합니다.",
      distance: "거리 판단 정보가 부족합니다.",
      pose: "포즈 판단 정보가 부족합니다.",
      lighting: "조명 판단 정보가 부족합니다.",
    };
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;

    const source = value as Record<string, unknown>;
    for (const key of Object.keys(fallback)) {
      const text = source[key];
      if (typeof text === "string" && text.trim()) fallback[key] = text.trim();
    }
    return fallback;
  }
}
