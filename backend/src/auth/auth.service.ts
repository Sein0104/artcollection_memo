import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../prisma.service";

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async signup(nickname: string, password: string) {
    const existing = await this.prisma.user.findUnique({ where: { nickname } });
    if (existing && existing.passwordHash !== "seed") {
      throw new ConflictException("nickname_taken");
    }

    const { hash, salt } = this.hashPassword(password);
    const user = existing
      ? await this.prisma.user.update({
          where: { nickname },
          data: { passwordHash: hash, passwordSalt: salt },
        })
      : await this.prisma.user.create({
          data: { nickname, passwordHash: hash, passwordSalt: salt },
        });

    return { user: { id: user.id, nickname: user.nickname }, state: await this.userState(user.id) };
  }

  async login(nickname: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { nickname } });
    if (!user || !this.verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      throw new UnauthorizedException("login_failed");
    }
    return { user: { id: user.id, nickname: user.nickname }, state: await this.userState(user.id) };
  }

  async state(nickname: string) {
    const user = await this.prisma.user.findUnique({ where: { nickname } });
    if (!user) throw new UnauthorizedException("login_required");
    return { user: { id: user.id, nickname: user.nickname }, state: await this.userState(user.id) };
  }

  async userState(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { collections: true, purchases: true },
    });
    if (!user) throw new UnauthorizedException("login_required");
    return {
      points: user.points,
      totalEarnedPoints: user.totalEarnedPoints,
      installedRewardId: user.installedRewardId,
      collection: user.collections
        .filter((entry) => entry.source === "GENERAL")
        .map((entry) => ({
          artworkId: entry.artworkId,
          source: "일반",
          createdAt: entry.createdAt,
        })),
      missionCollection: user.collections
        .filter((entry) => entry.source === "MISSION")
        .map((entry) => ({
          artworkId: entry.artworkId,
          source: "미션",
          dateKey: entry.missionKey,
          createdAt: entry.createdAt,
        })),
      purchases: user.purchases.map((purchase) => purchase.artworkId),
    };
  }

  private hashPassword(password: string) {
    const salt = randomBytes(16).toString("hex");
    return { salt, hash: scryptSync(password, salt, 32).toString("hex") };
  }

  private verifyPassword(password: string, salt: string, expectedHash: string) {
    if (expectedHash === "seed") return false;
    const actual = Buffer.from(scryptSync(password, salt, 32).toString("hex"), "hex");
    const expected = Buffer.from(expectedHash, "hex");
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  }
}
