import { Body, Controller, Get, NotFoundException, Param, Patch, Query, Req } from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { AutoModService } from "./auto-mod.service";
import { ReviewModerationCaseDto } from "./dto";

type RequestWithCookie = {
  headers: {
    cookie?: string;
  };
};

@Controller("moderation")
export class AutoModController {
  constructor(
    private readonly autoMod: AutoModService,
    private readonly auth: AuthService,
  ) {}

  @Get("cases")
  async listCases(@Req() request: RequestWithCookie, @Query("status") status = "open") {
    await this.auth.requireUserFromCookie(request.headers.cookie);
    return this.autoMod.listCases(status);
  }

  @Patch("cases/:id")
  async reviewCase(@Param("id") id: string, @Body() body: ReviewModerationCaseDto, @Req() request: RequestWithCookie) {
    await this.auth.requireUserFromCookie(request.headers.cookie);
    const result = await this.autoMod.reviewCase(id, body.decision, body.reviewerNote?.trim() ?? "");
    if (!result) throw new NotFoundException("moderation_case_not_found");
    return result;
  }
}
