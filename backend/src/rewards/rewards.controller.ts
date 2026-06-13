import { Body, Controller, Post } from "@nestjs/common";
import { RewardDto } from "./dto";
import { RewardsService } from "./rewards.service";

@Controller("rewards")
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @Post("buy")
  buy(@Body() body: RewardDto) {
    return this.rewards.buy(body);
  }

  @Post("install")
  install(@Body() body: RewardDto) {
    return this.rewards.install(body);
  }
}
