import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from "class-validator";

export class CompleteMissionDto {
  @IsString()
  @Length(1, 7)
  nickname!: string;

  @IsString()
  artworkId!: string;
}

export class AnalyzeMissionDto {
  @IsOptional()
  @IsString()
  @Length(1, 7)
  nickname?: string;

  @IsString()
  artworkId!: string;

  @IsOptional()
  @IsIn(["capture", "pose"])
  mode?: "capture" | "pose";

  @IsString()
  @MaxLength(10_500_000)
  @Matches(/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i)
  imageDataUrl!: string;
}
