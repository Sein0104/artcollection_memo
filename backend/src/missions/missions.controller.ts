import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { AnalyzeMissionDto, CompleteMissionDto } from "./dto";
import { MissionsService } from "./missions.service";

type RequestWithCookie = {
  headers: {
    cookie?: string;
  };
};

@Controller("missions")
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  @Get("daily")
  daily() {
    return this.missions.daily();
  }

  @Post("complete")
  complete(@Body() body: CompleteMissionDto, @Req() request: RequestWithCookie) {
    return this.missions.complete(body, request.headers.cookie);
  }

  @Post("analyze")
  analyze(@Body() body: AnalyzeMissionDto, @Req() request: RequestWithCookie) {
    return this.missions.analyze(body, request.headers.cookie);
  }
}
