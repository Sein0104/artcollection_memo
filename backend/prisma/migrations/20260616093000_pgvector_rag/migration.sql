CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "MissionAnalysisRecord"
  ADD COLUMN IF NOT EXISTS "embeddingVector" vector(1536);

ALTER TABLE "ArtworkKnowledge"
  ADD COLUMN IF NOT EXISTS "embeddingVector" vector(1536);

CREATE INDEX IF NOT EXISTS "MissionAnalysisRecord_embeddingVector_ivfflat_idx"
  ON "MissionAnalysisRecord"
  USING ivfflat ("embeddingVector" vector_cosine_ops)
  WITH (lists = 100)
  WHERE "embeddingVector" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ArtworkKnowledge_embeddingVector_ivfflat_idx"
  ON "ArtworkKnowledge"
  USING ivfflat ("embeddingVector" vector_cosine_ops)
  WITH (lists = 100)
  WHERE "embeddingVector" IS NOT NULL;
