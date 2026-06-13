import { Controller, Get } from "@nestjs/common";
import { ArtworksService } from "./artworks.service";

@Controller("artworks")
export class ArtworksController {
  constructor(private readonly artworks: ArtworksService) {}

  @Get()
  list() {
    return this.artworks.list();
  }
}
