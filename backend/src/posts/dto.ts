import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Length } from "class-validator";

export class CreatePostDto {
  @IsString()
  @Length(1, 36)
  title!: string;

  @IsString()
  @Length(1, 100000)
  body!: string;

  @IsString()
  museumId!: string;

  @IsOptional()
  @IsIn(["free", "review"])
  boardType?: "free" | "review";

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  tags?: string[];
}

export class CreateCommentDto {
  @IsString()
  @Length(1, 240)
  body!: string;

  @IsOptional()
  @IsString()
  parentId?: string;
}

export class VotePostDto {
  @IsIn(["up", "down"])
  type!: "up" | "down";
}

export class UpdatePostDto {
  @IsString()
  @Length(1, 36)
  title!: string;

  @IsString()
  @Length(1, 1200)
  body!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  tags?: string[];
}
