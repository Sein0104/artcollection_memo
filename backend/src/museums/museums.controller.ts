import { Controller, Get } from "@nestjs/common";
import { MuseumsService } from "./museums.service";

@Controller("museums")
export class MuseumsController {
  constructor(private readonly museums: MuseumsService) {}

  @Get()
  list() {
    return this.museums.list();
  }
}
