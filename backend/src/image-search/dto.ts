import { IsString, Matches, MaxLength } from "class-validator";

export class SearchSimilarImageDto {
  @IsString()
  @MaxLength(4_194_304)
  @Matches(/^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i)
  imageDataUrl!: string;
}
