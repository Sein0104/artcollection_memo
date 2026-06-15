import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { CreateCommentDto, CreatePostDto, UpdatePostDto, VotePostDto } from "./dto";
import { PostsService } from "./posts.service";

type RequestWithCookie = {
  headers: {
    cookie?: string;
  };
};

@Controller("posts")
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  list() {
    return this.posts.list();
  }

  @Post()
  create(@Body() body: CreatePostDto, @Req() request: RequestWithCookie) {
    return this.posts.create(body, request.headers.cookie);
  }

  @Get(":id")
  detail(@Param("id") id: string, @Req() request: RequestWithCookie) {
    return this.posts.detail(id, request.headers.cookie);
  }

  @Post(":id/comments")
  comment(@Param("id") id: string, @Body() body: CreateCommentDto, @Req() request: RequestWithCookie) {
    return this.posts.comment(id, body, request.headers.cookie);
  }

  @Post(":id/vote")
  vote(@Param("id") id: string, @Body() body: VotePostDto, @Req() request: RequestWithCookie) {
    return this.posts.vote(id, body, request.headers.cookie);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdatePostDto, @Req() request: RequestWithCookie) {
    return this.posts.update(id, body, request.headers.cookie);
  }

  @Delete(":id")
  remove(@Param("id") id: string, @Req() request: RequestWithCookie) {
    return this.posts.remove(id, request.headers.cookie);
  }
}
