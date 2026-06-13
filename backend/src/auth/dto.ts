import { IsString, Length } from "class-validator";

export class AuthDto {
  @IsString()
  @Length(1, 7)
  nickname!: string;

  @IsString()
  @Length(4, 64)
  password!: string;
}
