import assert from "node:assert/strict";
import { MissionsService } from "../dist/missions/missions.service.js";

function record({ artworkId, feedback, embedding = [1, 0, 0], passed = true }) {
  return {
    id: `${artworkId}-${feedback}`,
    userId: "user-test",
    artworkId,
    artwork: { id: artworkId, title: artworkId },
    mode: "pose",
    score: passed ? 80 : 35,
    passed,
    feedback,
    coachTip: "",
    analysisText: "useful composition and pose feedback",
    aspects: null,
    embedding,
    createdAt: new Date(),
  };
}

function serviceWithRecords(records) {
  const calls = { findManyWhere: null };
  const prisma = {
    missionAnalysisRecord: {
      findMany: async ({ where }) => {
        calls.findManyWhere = where;
        return records.filter((item) => item.artworkId === where.artworkId && item.mode === where.mode);
      },
    },
  };
  const service = new MissionsService(prisma, {}, { get: () => "" });
  service.pgVectorReadDisabled = true;
  return { service, calls };
}

async function testRequiresThreeSameArtworkRecords() {
  const { service, calls } = serviceWithRecords([
    record({ artworkId: "target-art", feedback: "same 1" }),
    record({ artworkId: "target-art", feedback: "same 2" }),
    record({ artworkId: "other-art", feedback: "other 1" }),
    record({ artworkId: "other-art", feedback: "other 2" }),
    record({ artworkId: "other-art", feedback: "other 3" }),
  ]);

  const tip = await service.findCoachTip({ artworkId: "target-art", mode: "pose", embedding: [1, 0, 0] });

  assert.equal(tip, "");
  assert.deepEqual(calls.findManyWhere, { artworkId: "target-art", mode: "pose" });
  console.log("PASS mission coach hides tip when same artwork history is below threshold");
}

async function testUsesOnlySameArtworkRecords() {
  const { service } = serviceWithRecords([
    record({ artworkId: "target-art", feedback: "same best", embedding: [1, 0, 0] }),
    record({ artworkId: "target-art", feedback: "same second", embedding: [0.95, 0.05, 0] }),
    record({ artworkId: "target-art", feedback: "same third", embedding: [0.9, 0.1, 0] }),
    record({ artworkId: "other-art", feedback: "other should not appear", embedding: [1, 0, 0] }),
  ]);

  const tip = await service.findCoachTip({ artworkId: "target-art", mode: "pose", embedding: [1, 0, 0] });

  assert.match(tip, /same best/);
  assert.doesNotMatch(tip, /other should not appear/);
  console.log("PASS mission coach uses same artwork records only");
}

await testRequiresThreeSameArtworkRecords();
await testUsesOnlySameArtworkRecords();
