import { Body, Controller, Get, Post } from "@nestjs/common";
import { AnalyzeMissionDto, CompleteMissionDto } from "./dto";
import { MissionsService } from "./missions.service";

@Controller("missions")
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  @Get("daily")
  daily() {
    return this.missions.daily();
  }

  @Post("complete")
  complete(@Body() body: CompleteMissionDto) {
    return this.missions.complete(body);
  }

  @Post("analyze")
  analyze(@Body() body: AnalyzeMissionDto) {
    return this.missions.analyze(body);
  }
}
