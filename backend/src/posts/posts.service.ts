import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { AuthService } from "../auth/auth.service";
import { AutoModService } from "../auto-mod/auto-mod.service";
import { CreateCommentDto, CreatePostDto, UpdatePostDto, VotePostDto } from "./dto";

const GENERAL_POST_MUSEUM_ID = "general-post";
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

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly autoMod: AutoModService,
  ) {}

  async list() {
    const posts = await this.prisma.post.findMany({
      where: { status: "published" },
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
    if (!title || !body) throw new BadRequestException("post_content_required");
    const moderation = await this.autoMod.review({
      targetType: "post",
      authorId: user.id,
      title,
      body,
    });

    const post = await this.prisma.post.create({
      data: {
        authorId: user.id,
        title,
        body,
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
    if (!title || !body) throw new BadRequestException("post_content_required");
    const moderation = await this.autoMod.review({
      targetType: "post",
      authorId: user.id,
      title,
      body,
      postId,
    });

    await this.prisma.post.update({
      where: { id: postId },
      data: {
        title,
        body,
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
}
