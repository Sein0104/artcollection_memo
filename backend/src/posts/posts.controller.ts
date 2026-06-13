import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { CreateCommentDto, CreatePostDto, DeletePostDto, UpdatePostDto, VotePostDto } from "./dto";
import { PostsService } from "./posts.service";

@Controller("posts")
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get()
  list() {
    return this.posts.list();
  }

  @Post()
  create(@Body() body: CreatePostDto) {
    return this.posts.create(body);
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    return this.posts.detail(id);
  }

  @Post(":id/comments")
  comment(@Param("id") id: string, @Body() body: CreateCommentDto) {
    return this.posts.comment(id, body);
  }

  @Post(":id/vote")
  vote(@Param("id") id: string, @Body() body: VotePostDto) {
    return this.posts.vote(id, body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdatePostDto) {
    return this.posts.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string, @Body() body: DeletePostDto) {
    return this.posts.remove(id, body);
  }
}
