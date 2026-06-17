import { Body, Controller, Post, Req } from "@nestjs/common";
import { RewardDto } from "./dto";
import { RewardsService } from "./rewards.service";

type RequestWithCookie = {
  headers: {
    cookie?: string;
  };
};

@Controller("rewards")
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @Post("buy")
  buy(@Body() body: RewardDto, @Req() request: RequestWithCookie) {
    return this.rewards.buy(body, request.headers.cookie);
  }

  @Post("install")
  install(@Body() body: RewardDto, @Req() request: RequestWithCookie) {
    return this.rewards.install(body, request.headers.cookie);
  }
}
