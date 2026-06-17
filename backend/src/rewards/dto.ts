import { IsString } from "class-validator";

export class RewardDto {
  @IsString()
  artworkId!: string;
}
