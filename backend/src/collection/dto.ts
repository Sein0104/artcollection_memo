import { IsString, Length } from "class-validator";

export class AddCollectionDto {
  @IsString()
  @Length(1, 7)
  nickname!: string;

  @IsString()
  artworkId!: string;
}
