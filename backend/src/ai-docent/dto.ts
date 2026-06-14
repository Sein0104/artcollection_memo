import { IsString, Length } from "class-validator";

export class AskDocentDto {
  @IsString()
  @Length(1, 500)
  message!: string;
}
