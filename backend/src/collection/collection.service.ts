import { BadRequestException, Injectable } from "@nestjs/common";
import { AddCollectionDto } from "./dto";

@Injectable()
export class CollectionService {
  add(_dto: AddCollectionDto) {
    throw new BadRequestException("mission_only_collection");
  }
}
