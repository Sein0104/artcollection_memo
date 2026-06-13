import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { AuthService } from "../auth/auth.service";
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
  ) {}

  async list() {
    const posts = await this.prisma.post.findMany({
      orderBy: { createdAt: "desc" },
      include: { author: true, museum: true, comments: true },
    });
    return { posts: posts.map((post) => this.toPostSummary(post)) };
  }

  async detail(id: string) {
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        author: true,
        museum: true,
        comments: {
          orderBy: { createdAt: "asc" },
          include: { author: true },
        },
      },
    });
    if (!post) throw new NotFoundException("post_not_found");
    return { post: this.toPostDetail(post) };
  }

  async create(dto: CreatePostDto, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);
    const museumId = await this.resolveMuseumId(dto.museumId);

    await this.prisma.post.create({
      data: {
        authorId: user.id,
        title: dto.title,
        body: dto.body,
        museumId,
        boardType: dto.boardType ?? "free",
      },
    });

    return this.list();
  }

  async comment(postId: string, dto: CreateCommentDto, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);

    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException("post_not_found");

    if (dto.parentId) {
      const parent = await this.prisma.postComment.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.postId !== postId) throw new BadRequestException("invalid_parent_comment");
    }

    await this.prisma.postComment.create({
      data: {
        postId,
        authorId: user.id,
        parentId: dto.parentId,
        body: dto.body,
      },
    });

    return this.detail(postId);
  }

  async vote(postId: string, dto: VotePostDto, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);

    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException("post_not_found");

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

    await this.prisma.post.update({
      where: { id: postId },
      data: {
        title,
        body,
      },
    });

    return this.detail(postId);
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

  private toPostSummary(post: any) {
    return {
      id: post.id,
      author: post.author.nickname,
      authorTitle: this.titleFor(post.author.totalEarnedPoints ?? 0),
      title: post.title,
      body: post.body,
      boardType: post.boardType ?? "free",
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
