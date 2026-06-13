ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totalEarnedPoints" INTEGER NOT NULL DEFAULT 40;
UPDATE "User" SET "totalEarnedPoints" = GREATEST("totalEarnedPoints", "points", 40);

CREATE TABLE IF NOT EXISTS "MissionAnalysisRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "artworkId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "feedback" TEXT NOT NULL,
    "coachTip" TEXT NOT NULL DEFAULT '',
    "analysisText" TEXT NOT NULL,
    "aspects" JSONB,
    "embedding" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionAnalysisRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MissionAnalysisRecord_artworkId_mode_idx" ON "MissionAnalysisRecord"("artworkId", "mode");
CREATE INDEX IF NOT EXISTS "MissionAnalysisRecord_createdAt_idx" ON "MissionAnalysisRecord"("createdAt");

ALTER TABLE "MissionAnalysisRecord" DROP CONSTRAINT IF EXISTS "MissionAnalysisRecord_userId_fkey";
ALTER TABLE "MissionAnalysisRecord" ADD CONSTRAINT "MissionAnalysisRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MissionAnalysisRecord" DROP CONSTRAINT IF EXISTS "MissionAnalysisRecord_artworkId_fkey";
ALTER TABLE "MissionAnalysisRecord" ADD CONSTRAINT "MissionAnalysisRecord_artworkId_fkey" FOREIGN KEY ("artworkId") REFERENCES "Artwork"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
