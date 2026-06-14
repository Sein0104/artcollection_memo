CREATE TABLE IF NOT EXISTS "ArtworkKnowledge" (
  "id" TEXT NOT NULL,
  "artworkId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "embedding" JSONB,
  "sourceType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ArtworkKnowledge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ArtworkKnowledge_artworkId_sourceType_key" ON "ArtworkKnowledge"("artworkId", "sourceType");
CREATE INDEX IF NOT EXISTS "ArtworkKnowledge_artworkId_idx" ON "ArtworkKnowledge"("artworkId");
CREATE INDEX IF NOT EXISTS "ArtworkKnowledge_sourceType_idx" ON "ArtworkKnowledge"("sourceType");

ALTER TABLE "ArtworkKnowledge" DROP CONSTRAINT IF EXISTS "ArtworkKnowledge_artworkId_fkey";
ALTER TABLE "ArtworkKnowledge" ADD CONSTRAINT "ArtworkKnowledge_artworkId_fkey" FOREIGN KEY ("artworkId") REFERENCES "Artwork"("id") ON DELETE CASCADE ON UPDATE CASCADE;
