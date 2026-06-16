import { Body, Controller, Get, Post } from "@nestjs/common";
import { SearchSimilarImageDto } from "./dto";
import { ImageSearchService } from "./image-search.service";

@Controller("image-search")
export class ImageSearchController {
  constructor(private readonly imageSearch: ImageSearchService) {}

  @Get("status")
  status() {
    return this.imageSearch.status();
  }

  @Post("similar")
  similar(@Body() dto: SearchSimilarImageDto) {
    return this.imageSearch.similar(dto);
  }
}
