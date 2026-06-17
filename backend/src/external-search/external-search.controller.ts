import { Controller, Get, Query } from "@nestjs/common";
import { ExternalSearchService } from "./external-search.service";

@Controller("external-search")
export class ExternalSearchController {
  constructor(private readonly externalSearch: ExternalSearchService) {}

  @Get()
  search(@Query("q") query = "") {
    return this.externalSearch.search(query);
  }
}
