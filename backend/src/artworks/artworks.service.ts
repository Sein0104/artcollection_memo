import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service";
import { REMOVED_ARTWORK_IDS, withLocalArtworkImage } from "./image-overrides";

@Injectable()
export class ArtworksService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const artworks = await this.prisma.artwork.findMany({
      where: {
        id: { notIn: REMOVED_ARTWORK_IDS },
        image: { not: null },
      },
      orderBy: [{ premium: "asc" }, { title: "asc" }],
    });
    return { artworks: artworks.map(withLocalArtworkImage) };
  }
}
