import { IsIn, IsOptional, IsString, Length } from "class-validator";

export class ReviewModerationCaseDto {
  @IsIn(["approve", "reject", "resolve"])
  decision!: "approve" | "reject" | "resolve";

  @IsOptional()
  @IsString()
  @Length(0, 240)
  reviewerNote?: string;
}
