import { IsIn, IsOptional, IsString, Length } from "class-validator";

export class CreatePostDto {
  @IsString()
  @Length(1, 7)
  nickname!: string;

  @IsString()
  @Length(1, 36)
  title!: string;

  @IsString()
  @Length(1, 240)
  body!: string;

  @IsString()
  museumId!: string;

  @IsOptional()
  @IsIn(["free", "review"])
  boardType?: "free" | "review";
}

export class CreateCommentDto {
  @IsString()
  @Length(1, 7)
  nickname!: string;

  @IsString()
  @Length(1, 240)
  body!: string;

  @IsOptional()
  @IsString()
  parentId?: string;
}

export class VotePostDto {
  @IsString()
  @Length(1, 7)
  nickname!: string;

  @IsIn(["up", "down"])
  type!: "up" | "down";
}

export class DeletePostDto {
  @IsString()
  @Length(1, 7)
  nickname!: string;
}

export class UpdatePostDto {
  @IsString()
  @Length(1, 7)
  nickname!: string;

  @IsString()
  @Length(1, 36)
  title!: string;

  @IsString()
  @Length(1, 240)
  body!: string;
}
