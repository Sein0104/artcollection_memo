ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'published';
ALTER TABLE "PostComment" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'published';

CREATE INDEX IF NOT EXISTS "Post_status_createdAt_idx" ON "Post"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "PostComment_status_createdAt_idx" ON "PostComment"("status", "createdAt");

CREATE TABLE IF NOT EXISTS "ModerationCase" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "postId" TEXT,
    "commentId" TEXT,
    "authorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "severity" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "categories" TEXT[] NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB,
    "authorMessage" TEXT NOT NULL DEFAULT '',
    "adminSummary" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "reviewedAt" TIMESTAMP(3),
    "reviewerNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ModerationWarning" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationWarning_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ModerationCase_targetType_targetId_idx" ON "ModerationCase"("targetType", "targetId");
CREATE INDEX IF NOT EXISTS "ModerationCase_authorId_createdAt_idx" ON "ModerationCase"("authorId", "createdAt");
CREATE INDEX IF NOT EXISTS "ModerationCase_status_createdAt_idx" ON "ModerationCase"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "ModerationCase_action_createdAt_idx" ON "ModerationCase"("action", "createdAt");
CREATE INDEX IF NOT EXISTS "ModerationWarning_userId_createdAt_idx" ON "ModerationWarning"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "ModerationWarning_caseId_idx" ON "ModerationWarning"("caseId");

ALTER TABLE "ModerationCase" DROP CONSTRAINT IF EXISTS "ModerationCase_postId_fkey";
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ModerationCase" DROP CONSTRAINT IF EXISTS "ModerationCase_commentId_fkey";
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "PostComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ModerationCase" DROP CONSTRAINT IF EXISTS "ModerationCase_authorId_fkey";
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ModerationWarning" DROP CONSTRAINT IF EXISTS "ModerationWarning_userId_fkey";
ALTER TABLE "ModerationWarning" ADD CONSTRAINT "ModerationWarning_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ModerationWarning" DROP CONSTRAINT IF EXISTS "ModerationWarning_caseId_fkey";
ALTER TABLE "ModerationWarning" ADD CONSTRAINT "ModerationWarning_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ModerationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
