import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CollectionSource } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { yyyyMmDd } from "../common/date";
import { PrismaService } from "../prisma.service";
import { AuthService } from "../auth/auth.service";
import { REMOVED_ARTWORK_IDS, withLocalArtworkImage } from "../artworks/image-overrides";
import { AnalyzeMissionDto, CompleteMissionDto } from "./dto";

const MISSION_PASS_THRESHOLD = 62;
const EMBEDDING_SIMILARITY_THRESHOLD = 0.74;
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

@Injectable()
export class MissionsService {
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

  async complete(dto: CompleteMissionDto) {
    const user = await this.prisma.user.findUnique({ where: { nickname: dto.nickname } });
    if (!user) throw new UnauthorizedException("login_required");

    const { missions } = await this.daily();
    if (!missions.some((mission) => mission.id === dto.artworkId)) {
      throw new BadRequestException("not_daily_mission");
    }

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

  async analyze(dto: AnalyzeMissionDto): Promise<MissionAnalysisResult> {
    const artwork = await this.prisma.artwork.findFirst({
      where: {
        AND: [{ id: dto.artworkId }, { id: { notIn: REMOVED_ARTWORK_IDS } }],
        image: { not: null },
      },
    });
    if (!artwork) throw new BadRequestException("artwork_not_available");

    const reference = withLocalArtworkImage(artwork);
    if (!reference.image) throw new BadRequestException("artwork_image_missing");

    const mode = dto.mode ?? "capture";
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
      nickname: dto.nickname,
      artworkId: reference.id,
      mode,
      analysis: { ...analysis, analysisText, coachTip },
      embedding,
    });

    return {
      score: analysis.score,
      passed: analysis.passed,
      feedback: analysis.feedback,
      coachTip,
    };
  }

  private pickDailyMissions<T extends { id: string }>(artworks: T[], dateKey: string) {
    if (artworks.length <= 3) return artworks;
    const seed = [...dateKey].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const start = seed % artworks.length;
    return [0, 1, 2].map((offset) => artworks[(start + offset) % artworks.length]);
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
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.get<string>("OPENAI_EMBEDDING_MODEL") || "text-embedding-3-small",
          input: text,
        }),
      });
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

  private async storeMissionAnalysis({
    nickname,
    artworkId,
    mode,
    analysis,
    embedding,
  }: {
    nickname?: string;
    artworkId: string;
    mode: MissionMode;
    analysis: MissionAnalysisResult;
    embedding: number[] | null;
  }) {
    try {
      const user = nickname ? await this.prisma.user.findUnique({ where: { nickname } }) : null;
      const data: Record<string, unknown> = {
        artworkId,
        mode,
        score: analysis.score,
        passed: analysis.passed,
        feedback: analysis.feedback,
        coachTip: analysis.coachTip ?? "",
        analysisText: analysis.analysisText ?? analysis.feedback,
      };
      if (user) data.userId = user.id;
      if (analysis.aspects) data.aspects = analysis.aspects;
      if (embedding) data.embedding = embedding;

      await this.prisma.missionAnalysisRecord.create({ data: data as any });
    } catch {
      // The mission result should still be shown even if coach history cannot be stored yet.
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
        ? "The user is allowed to creatively imitate the artwork with people, poses, props, clothing, or staging. Score 0-100 by resemblance of pose, composition, subject placement, dominant shapes, colors, lighting, mood, and playful reinterpretation. Do not require the photo to be a direct photograph of the artwork."
        : "The user is trying to photograph a real scene or object that resembles the artwork. Score 0-100 by visual similarity: composition, subject placement, dominant shapes, colors, lighting, and mood.",
      "Return only strict JSON with this exact shape:",
      '{"score":72,"passed":true,"feedback":"Korean feedback in one concise, actionable sentence.","analysisText":"Korean summary of composition, color, distance, pose, and lighting reasons.","aspects":{"composition":"Korean note","color":"Korean note","distance":"Korean note","pose":"Korean note","lighting":"Korean note"}}',
      "If score is below the threshold, feedback must explain what to change in the next photo.",
      "analysisText and aspects must be useful for retrieving similar past success or failure patterns later.",
    ].join("\n");

    const response = await fetch("https://api.openai.com/v1/responses", {
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
    });

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(this.openAiErrorMessage(payload) || "openai_vision_failed");
    }

    const outputText = this.extractOutputText(payload);
    const parsed = this.parseAnalysisJson(outputText);
    return this.normalizeAnalysis(parsed);
  }

  private async artworkImageToModelInput(imagePath: string) {
    if (imagePath.startsWith("https://")) return imagePath;
    if (!imagePath.startsWith("/artworks/")) throw new BadRequestException("artwork_image_not_local");

    const workspaceRoot = process.cwd().endsWith("backend") ? resolve(process.cwd(), "..") : process.cwd();
    const publicRoot = resolve(workspaceRoot, "frontend", "public");
    const resolvedPath = resolve(publicRoot, imagePath.replace(/^\//, ""));
    if (!resolvedPath.startsWith(publicRoot)) throw new BadRequestException("artwork_image_not_local");

    const bytes = await readFile(resolvedPath);
    return `data:${this.mimeTypeFor(resolvedPath)};base64,${bytes.toString("base64")}`;
  }

  private mimeTypeFor(path: string) {
    const ext = extname(path).toLowerCase();
    if (ext === ".png") return "image/png";
    if (ext === ".webp") return "image/webp";
    return "image/jpeg";
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
