import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma.service";
import { AuthService } from "../auth/auth.service";
import { AutoModService } from "../auto-mod/auto-mod.service";
import { CreateCommentDto, CreatePostDto, UpdatePostDto, VotePostDto } from "./dto";

const GENERAL_POST_MUSEUM_ID = "general-post";
const MAX_POST_TAGS = 5;
const MAX_POST_TAG_LENGTH = 18;
const POST_TAGGING_TIMEOUT_MS = 15_000;
const POST_TAGS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["tags"],
};
const DELETED_COMMENT_BODY = "삭제된 댓글입니다.";
const IMAGE_SHARE_MARKER_PATTERN = /\n?\[\[ARTCATCH_IMAGE_SHARE:[A-Za-z0-9+/=]+\]\]\s*$/;
const TITLE_STEPS = [
  [4000, "마스터 큐레이터"],
  [3000, "컬렉션 디렉터"],
  [2400, "명예 수집가"],
  [1800, "전시 기획자"],
  [1200, "큐레이터 후보"],
  [800, "작품 탐험가"],
  [500, "갤러리 산책자"],
  [200, "신진 감상가"],
  [0, "새내기 감상가"],
] as const;

type ListPostsOptions = {
  page?: string | number;
  limit?: string | number;
  q?: string;
  board?: string;
  scope?: string;
  country?: string;
  area?: string;
  museumId?: string;
  tag?: string;
};

const DEFAULT_POST_PAGE_SIZE = 8;
const MAX_POST_PAGE_SIZE = 30;

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly autoMod: AutoModService,
    private readonly config: ConfigService,
  ) {}

  async list(options: ListPostsOptions = {}) {
    const where = this.postListWhere(options);
    const pagination = this.paginationFrom(options);

    if (pagination) {
      const total = await this.prisma.post.count({ where });
      const posts = await this.prisma.post.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
        include: { author: true, museum: true, comments: { where: { status: "published" } } },
      });
      const totalPages = Math.max(1, Math.ceil(total / pagination.limit));
      return {
        posts: posts.map((post) => this.toPostSummary(post)),
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages,
        hasPrev: pagination.page > 1,
        hasNext: pagination.page < totalPages,
      };
    }

    const posts = await this.prisma.post.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { author: true, museum: true, comments: { where: { status: "published" } } },
    });
    return { posts: posts.map((post) => this.toPostSummary(post)) };
  }

  async detail(id: string, cookieHeader?: string) {
    const viewer = await this.optionalUserFromCookie(cookieHeader);
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        author: true,
        museum: true,
        comments: {
          where: { status: "published" },
          orderBy: { createdAt: "asc" },
          include: { author: true },
        },
      },
    });
    if (!post) throw new NotFoundException("post_not_found");
    if (post.status !== "published" && post.authorId !== viewer?.id) throw new NotFoundException("post_not_found");
    return { post: this.toPostDetail(post) };
  }

  async create(dto: CreatePostDto, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);
    const museumId = await this.resolveMuseumId(dto.museumId);
    const title = dto.title.trim();
    const body = dto.body.trim();
    const visibleBody = this.visiblePostBody(body);
    if (!title || !visibleBody) throw new BadRequestException("post_content_required");
    const moderation = await this.autoMod.review({
      targetType: "post",
      authorId: user.id,
      title,
      body: visibleBody,
    });
    if (this.autoMod.isBlockingAction(moderation.action)) {
      await this.autoMod.recordCase({
        targetType: "post",
        targetId: `preflight-${randomUUID()}`,
        authorId: user.id,
        decision: moderation,
        status: "resolved",
      });
      return { ...(await this.list()), moderation: this.autoMod.noticeFor(moderation) };
    }

    const tags = await this.resolveTags(dto.tags, title, visibleBody);

    const post = await this.prisma.post.create({
      data: {
        authorId: user.id,
        title,
        body,
        tags,
        museumId,
        boardType: dto.boardType ?? "free",
        status: this.autoMod.publicStatusFor(moderation.action),
      },
    });

    await this.autoMod.recordCase({
      targetType: "post",
      targetId: post.id,
      postId: post.id,
      authorId: user.id,
      decision: moderation,
    });

    return { ...(await this.list()), moderation: this.autoMod.noticeFor(moderation) };
  }

  async comment(postId: string, dto: CreateCommentDto, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);

    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException("post_not_found");
    if (post.status !== "published") throw new NotFoundException("post_not_found");

    if (dto.parentId) {
      const parent = await this.prisma.postComment.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.postId !== postId || parent.status !== "published") throw new BadRequestException("invalid_parent_comment");
    }

    const body = dto.body.trim();
    if (!body) throw new BadRequestException("comment_content_required");
    const moderation = await this.autoMod.review({
      targetType: "comment",
      authorId: user.id,
      body,
      postId,
      parentId: dto.parentId,
    });
    if (this.autoMod.isBlockingAction(moderation.action)) {
      await this.autoMod.recordCase({
        targetType: "comment",
        targetId: `preflight-${randomUUID()}`,
        postId,
        authorId: user.id,
        decision: moderation,
        status: "resolved",
      });
      return { ...(await this.detail(postId, cookieHeader)), moderation: this.autoMod.noticeFor(moderation) };
    }

    const comment = await this.prisma.postComment.create({
      data: {
        postId,
        authorId: user.id,
        parentId: dto.parentId,
        body,
        status: this.autoMod.publicStatusFor(moderation.action),
      },
    });

    await this.autoMod.recordCase({
      targetType: "comment",
      targetId: comment.id,
      postId,
      commentId: comment.id,
      authorId: user.id,
      decision: moderation,
    });

    return { ...(await this.detail(postId, cookieHeader)), moderation: this.autoMod.noticeFor(moderation) };
  }

  async removeComment(postId: string, commentId: string, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);

    const comment = await this.prisma.postComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.postId !== postId || comment.status !== "published") throw new NotFoundException("comment_not_found");
    if (comment.authorId !== user.id) throw new ForbiddenException("not_comment_author");

    if (comment.body !== DELETED_COMMENT_BODY) {
      await this.prisma.postComment.update({
        where: { id: commentId },
        data: { body: DELETED_COMMENT_BODY },
      });
    }

    return this.detail(postId, cookieHeader);
  }

  async vote(postId: string, dto: VotePostDto, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);

    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException("post_not_found");
    if (post.status !== "published") throw new NotFoundException("post_not_found");

    const existingVote = await this.prisma.postVote.findUnique({
      where: {
        postId_userId: {
          postId,
          userId: user.id,
        },
      },
    });
    if (existingVote) throw new BadRequestException("already_voted");

    await this.prisma.$transaction([
      this.prisma.postVote.create({
        data: {
          postId,
          userId: user.id,
          type: dto.type,
        },
      }),
      this.prisma.post.update({
        where: { id: postId },
        data: dto.type === "up" ? { upVotes: { increment: 1 } } : { downVotes: { increment: 1 } },
      }),
    ]);

    return this.detail(postId);
  }

  async update(postId: string, dto: UpdatePostDto, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);

    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException("post_not_found");
    if (post.authorId !== user.id) throw new ForbiddenException("not_post_author");

    const title = dto.title.trim();
    const body = dto.body.trim();
    const visibleBody = this.visiblePostBody(body);
    if (!title || !visibleBody) throw new BadRequestException("post_content_required");
    const moderation = await this.autoMod.review({
      targetType: "post",
      authorId: user.id,
      title,
      body: visibleBody,
      postId,
    });
    if (this.autoMod.isBlockingAction(moderation.action)) {
      await this.autoMod.recordCase({
        targetType: "post",
        targetId: postId,
        postId,
        authorId: user.id,
        decision: moderation,
        status: "resolved",
      });
      return { ...(await this.detail(postId, cookieHeader)), moderation: this.autoMod.noticeFor(moderation) };
    }

    const tags = await this.resolveTags(dto.tags, title, visibleBody);

    await this.prisma.post.update({
      where: { id: postId },
      data: {
        title,
        body,
        tags,
        status: this.autoMod.publicStatusFor(moderation.action),
      },
    });

    await this.autoMod.recordCase({
      targetType: "post",
      targetId: postId,
      postId,
      authorId: user.id,
      decision: moderation,
    });

    return { ...(await this.detail(postId, cookieHeader)), moderation: this.autoMod.noticeFor(moderation) };
  }

  async remove(postId: string, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);

    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException("post_not_found");
    if (post.authorId !== user.id) throw new ForbiddenException("not_post_author");

    await this.prisma.post.delete({ where: { id: postId } });
    return this.list();
  }

  private postListWhere(options: ListPostsOptions) {
    const conditions: any[] = [{ status: "published" }];
    const board = this.nonDefaultFilter(options.board);
    const query = this.nonDefaultFilter(options.q);
    const scope = this.nonDefaultFilter(options.scope);
    const country = this.nonDefaultFilter(options.country);
    const area = this.nonDefaultFilter(options.area);
    const museumId = this.nonDefaultFilter(options.museumId);
    const tag = this.nonDefaultFilter(options.tag);

    if (tag) {
      conditions.push({ tags: { has: tag } });
    }

    if (board === "popular") {
      conditions.push({ upVotes: { gte: 10 } });
    } else if (board === "free" || board === "review") {
      conditions.push({ boardType: board });
    }

    if (query) {
      conditions.push({
        OR: [
          { title: { contains: query, mode: "insensitive" } },
          { body: { contains: query, mode: "insensitive" } },
          { museum: { is: { name: { contains: query, mode: "insensitive" } } } },
        ],
      });
    }

    if (museumId) {
      conditions.push({ museumId });
    } else {
      const museumFilters: Record<string, unknown> = {};
      if (scope) museumFilters.scope = scope;
      if (country) museumFilters.country = country;
      if (area) museumFilters.area = area;
      if (Object.keys(museumFilters).length) conditions.push({ museum: { is: museumFilters } });
    }

    return conditions.length === 1 ? conditions[0] : { AND: conditions };
  }

  private paginationFrom(options: ListPostsOptions) {
    if (options.page === undefined && options.limit === undefined) return null;

    const page = this.clampInt(Number(options.page ?? 1), 1, 100_000);
    const limit = this.clampInt(Number(options.limit ?? DEFAULT_POST_PAGE_SIZE), 1, MAX_POST_PAGE_SIZE);
    return { page, limit };
  }

  private nonDefaultFilter(value: unknown) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    return trimmed && trimmed !== "전체" ? trimmed : "";
  }

  private visiblePostBody(body: string) {
    return body.replace(IMAGE_SHARE_MARKER_PATTERN, "").trim();
  }

  private clampInt(value: number, min: number, max: number) {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  private async resolveMuseumId(museumId: string) {
    if (museumId && museumId !== "__none__") return museumId;

    const museum = await this.prisma.museum.upsert({
      where: { id: GENERAL_POST_MUSEUM_ID },
      update: {},
      create: {
        id: GENERAL_POST_MUSEUM_ID,
        name: "태그 없음",
        scope: "일반",
        country: "",
        area: "",
        city: "",
        tags: [],
      },
    });
    return museum.id;
  }

  private async optionalUserFromCookie(cookieHeader?: string) {
    try {
      return await this.auth.requireUserFromCookie(cookieHeader);
    } catch {
      return null;
    }
  }

  private toPostSummary(post: any) {
    return {
      id: post.id,
      author: post.author.nickname,
      authorTitle: this.titleFor(post.author.totalEarnedPoints ?? 0),
      title: post.title,
      body: post.body,
      tags: post.tags ?? [],
      boardType: post.boardType ?? "free",
      status: post.status ?? "published",
      museumId: post.museumId,
      museumName: post.museum.name,
      museumScope: post.museum.scope,
      museumCountry: post.museum.country,
      museumArea: post.museum.area,
      upVotes: post.upVotes,
      downVotes: post.downVotes,
      commentCount: post.comments?.length ?? 0,
      createdAt: post.createdAt,
    };
  }

  private toPostDetail(post: any) {
    return {
      ...this.toPostSummary(post),
      comments: this.nestComments(
        post.comments.map((comment: any) => ({
          id: comment.id,
          author: comment.author.nickname,
          authorTitle: this.titleFor(comment.author.totalEarnedPoints ?? 0),
          body: comment.body,
          status: comment.status ?? "published",
          parentId: comment.parentId,
          createdAt: comment.createdAt,
          replies: [],
        })),
      ),
    };
  }

  private titleFor(totalEarnedPoints: number) {
    return TITLE_STEPS.find(([minPoints]) => totalEarnedPoints >= minPoints)?.[1] ?? "새내기 감상가";
  }

  private nestComments(comments: any[]) {
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    const roots: any[] = [];
    for (const comment of comments) {
      if (comment.parentId && byId.has(comment.parentId)) {
        byId.get(comment.parentId).replies.push(comment);
      } else {
        roots.push(comment);
      }
    }
    return roots;
  }

  // Tags come from the author when provided; otherwise the LLM auto-tags the post.
  // Both paths run through normalizeTags so stored tags are always clean.
  private async resolveTags(authorTags: string[] | undefined, title: string, body: string) {
    const provided = this.normalizeTags(authorTags);
    if (provided.length) return provided;
    return this.generateTags(title, body);
  }

  private async generateTags(title: string, body: string): Promise<string[]> {
    const apiKey = this.config.get<string>("OPENAI_API_KEY")?.trim();
    const text = `${title}\n${body}`.trim();
    if (!apiKey || !text) return [];

    try {
      const response = await this.fetchWithTimeout(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.taggingModel(),
            input: [{ role: "user", content: [{ type: "input_text", text: this.taggingPrompt(title, body) }] }],
            text: {
              format: {
                type: "json_schema",
                name: "post_tags",
                strict: true,
                schema: POST_TAGS_JSON_SCHEMA,
              },
            },
            max_output_tokens: 200,
          }),
        },
        POST_TAGGING_TIMEOUT_MS,
      );

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) return [];
      const parsed = this.parseJsonObject(this.extractOutputText(payload));
      return this.normalizeTags(parsed.tags);
    } catch {
      // Auto-tagging is best-effort: never block posting because tagging failed.
      return [];
    }
  }

  private taggingPrompt(title: string, body: string) {
    return [
      "You generate concise topic tags for a Korean art community board post.",
      "Return 3 to 5 Korean tags that capture the artwork, artist, museum, technique, era, or theme.",
      "Each tag must be a short noun phrase (1-3 words), no leading '#', no sentences, no duplicates.",
      "Call the response with a JSON object: { \"tags\": [...] }.",
      "",
      `Title: ${title}`,
      `Body: ${body.slice(0, 1500)}`,
    ].join("\n");
  }

  private taggingModel() {
    return (
      this.config.get<string>("POST_TAG_MODEL") ||
      this.config.get<string>("OPENAI_DOCENT_MODEL") ||
      this.config.get<string>("OPENAI_VISION_MODEL") ||
      "gpt-5.4-mini"
    );
  }

  private normalizeTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") continue;
      const tag = item.replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, MAX_POST_TAG_LENGTH);
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= MAX_POST_TAGS) break;
    }
    return tags;
  }

  private async fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractOutputText(payload: Record<string, unknown>) {
    const outputText = payload.output_text;
    if (typeof outputText === "string") return outputText;

    const output = Array.isArray(payload.output) ? payload.output : [];
    return output
      .flatMap((item) => (Array.isArray((item as { content?: unknown }).content) ? ((item as { content: unknown[] }).content) : []))
      .map((item) => {
        const record = item as { text?: unknown };
        return typeof record.text === "string" ? record.text : "";
      })
      .join("\n");
  }

  private parseJsonObject(text: string) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return {};
      const parsed = JSON.parse(match[0]) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    }
  }
}
