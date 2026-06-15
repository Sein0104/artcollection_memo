import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaService } from "./prisma.service";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { ArtworksController } from "./artworks/artworks.controller";
import { ArtworksService } from "./artworks/artworks.service";
import { MuseumsController } from "./museums/museums.controller";
import { MuseumsService } from "./museums/museums.service";
import { PostsController } from "./posts/posts.controller";
import { PostsService } from "./posts/posts.service";
import { CollectionController } from "./collection/collection.controller";
import { CollectionService } from "./collection/collection.service";
import { RewardsController } from "./rewards/rewards.controller";
import { RewardsService } from "./rewards/rewards.service";
import { MissionsController } from "./missions/missions.controller";
import { MissionsService } from "./missions/missions.service";
import { AiDocentController } from "./ai-docent/ai-docent.controller";
import { AiDocentService } from "./ai-docent/ai-docent.service";
import { ExternalSearchController } from "./external-search/external-search.controller";
import { ExternalSearchService } from "./external-search/external-search.service";
import { AutoModService } from "./auto-mod/auto-mod.service";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [
    AuthController,
    ArtworksController,
    MuseumsController,
    PostsController,
    CollectionController,
    RewardsController,
    MissionsController,
    AiDocentController,
    ExternalSearchController,
  ],
  providers: [
    PrismaService,
    AuthService,
    ArtworksService,
    MuseumsService,
    PostsService,
    CollectionService,
    RewardsService,
    MissionsService,
    AiDocentService,
    ExternalSearchService,
    AutoModService,
  ],
})
export class AppModule {}
