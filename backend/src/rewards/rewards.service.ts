import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { AuthService } from "../auth/auth.service";
import { RewardDto } from "./dto";

@Injectable()
export class RewardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async buy(dto: RewardDto, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);
    const artwork = await this.prisma.artwork.findUnique({ where: { id: dto.artworkId } });
    if (!artwork || !artwork.premium) throw new BadRequestException("invalid_reward");

    const existing = await this.prisma.purchase.findUnique({
      where: { userId_artworkId: { userId: user.id, artworkId: artwork.id } },
    });

    if (!existing) {
      if (user.points < artwork.cost) throw new BadRequestException("not_enough_points");
      await this.prisma.purchase.create({ data: { userId: user.id, artworkId: artwork.id } });
      await this.prisma.user.update({
        where: { id: user.id },
        data: { points: { decrement: artwork.cost }, installedRewardId: artwork.id },
      });
    } else {
      await this.prisma.user.update({ where: { id: user.id }, data: { installedRewardId: artwork.id } });
    }

    return { state: await this.auth.userState(user.id) };
  }

  async install(dto: RewardDto, cookieHeader?: string) {
    const user = await this.auth.requireUserFromCookie(cookieHeader);
    const purchase = await this.prisma.purchase.findUnique({
      where: { userId_artworkId: { userId: user.id, artworkId: dto.artworkId } },
    });
    if (!purchase) throw new BadRequestException("reward_not_owned");
    await this.prisma.user.update({ where: { id: user.id }, data: { installedRewardId: dto.artworkId } });
    return { state: await this.auth.userState(user.id) };
  }
}
