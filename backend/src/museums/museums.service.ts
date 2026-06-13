import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service";

@Injectable()
export class MuseumsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const museums = await this.prisma.museum.findMany({ orderBy: [{ scope: "asc" }, { name: "asc" }] });
    return { museums };
  }
}
