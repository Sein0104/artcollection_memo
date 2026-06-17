import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class CompleteMissionDto {
  @IsString()
  artworkId!: string;
}

export class AnalyzeMissionDto {
  @IsString()
  artworkId!: string;

  @IsOptional()
  @IsIn(["capture", "pose"])
  mode?: "capture" | "pose";

  @IsString()
  @MaxLength(4_194_304)
  @Matches(/^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i)
  imageDataUrl!: string;
}
