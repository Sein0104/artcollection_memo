-- Add CGV-style museum location fields.
ALTER TABLE "Museum" ADD COLUMN IF NOT EXISTS "country" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Museum" ADD COLUMN IF NOT EXISTS "area" TEXT NOT NULL DEFAULT '';

-- Posts now tag only museums, not individual artworks.
ALTER TABLE "Post" DROP CONSTRAINT IF EXISTS "Post_artworkId_fkey";
ALTER TABLE "Post" DROP COLUMN IF EXISTS "artworkId";

-- Rename the previous like counter into the new recommendation counter.
ALTER TABLE "Post" RENAME COLUMN "likes" TO "upVotes";
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "downVotes" INTEGER NOT NULL DEFAULT 0;

-- Comments support nested replies through parentId.
CREATE TABLE IF NOT EXISTS "PostComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PostComment_postId_parentId_idx" ON "PostComment"("postId", "parentId");

ALTER TABLE "PostComment" DROP CONSTRAINT IF EXISTS "PostComment_postId_fkey";
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PostComment" DROP CONSTRAINT IF EXISTS "PostComment_authorId_fkey";
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PostComment" DROP CONSTRAINT IF EXISTS "PostComment_parentId_fkey";
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "PostComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
