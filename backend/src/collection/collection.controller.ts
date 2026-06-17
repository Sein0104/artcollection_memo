import { Body, Controller, Post } from "@nestjs/common";
import { AddCollectionDto } from "./dto";
import { CollectionService } from "./collection.service";

@Controller("collections")
export class CollectionController {
  constructor(private readonly collections: CollectionService) {}

  @Post()
  add(@Body() body: AddCollectionDto) {
    return this.collections.add(body);
  }
}
