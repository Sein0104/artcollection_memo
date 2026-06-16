CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "ArtworkImageEmbedding" (
  "id" TEXT NOT NULL,
  "artworkId" TEXT NOT NULL,
  "image" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "embedding" JSONB,
  "embeddingVector" vector(512),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ArtworkImageEmbedding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ArtworkImageEmbedding_artworkId_model_key"
  ON "ArtworkImageEmbedding"("artworkId", "model");

CREATE INDEX IF NOT EXISTS "ArtworkImageEmbedding_artworkId_idx"
  ON "ArtworkImageEmbedding"("artworkId");

CREATE INDEX IF NOT EXISTS "ArtworkImageEmbedding_model_idx"
  ON "ArtworkImageEmbedding"("model");

CREATE INDEX IF NOT EXISTS "ArtworkImageEmbedding_embeddingVector_ivfflat_idx"
  ON "ArtworkImageEmbedding"
  USING ivfflat ("embeddingVector" vector_cosine_ops)
  WITH (lists = 100)
  WHERE "embeddingVector" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ArtworkImageEmbedding_artworkId_fkey'
  ) THEN
    ALTER TABLE "ArtworkImageEmbedding"
      ADD CONSTRAINT "ArtworkImageEmbedding_artworkId_fkey"
      FOREIGN KEY ("artworkId") REFERENCES "Artwork"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
