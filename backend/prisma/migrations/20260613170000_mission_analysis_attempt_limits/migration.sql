CREATE TABLE IF NOT EXISTS "MissionAnalysisAttempt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "artworkId" TEXT,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MissionAnalysisAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MissionAnalysisAttempt_userId_createdAt_idx" ON "MissionAnalysisAttempt"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "MissionAnalysisAttempt_userId_artworkId_createdAt_idx" ON "MissionAnalysisAttempt"("userId", "artworkId", "createdAt");
CREATE INDEX IF NOT EXISTS "MissionAnalysisAttempt_status_createdAt_idx" ON "MissionAnalysisAttempt"("status", "createdAt");

ALTER TABLE "MissionAnalysisAttempt" DROP CONSTRAINT IF EXISTS "MissionAnalysisAttempt_userId_fkey";
ALTER TABLE "MissionAnalysisAttempt" ADD CONSTRAINT "MissionAnalysisAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MissionAnalysisAttempt" DROP CONSTRAINT IF EXISTS "MissionAnalysisAttempt_artworkId_fkey";
ALTER TABLE "MissionAnalysisAttempt" ADD CONSTRAINT "MissionAnalysisAttempt_artworkId_fkey" FOREIGN KEY ("artworkId") REFERENCES "Artwork"("id") ON DELETE SET NULL ON UPDATE CASCADE;
