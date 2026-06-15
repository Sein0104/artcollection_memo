import assert from "node:assert/strict";
import { AutoModService } from "../dist/auto-mod/auto-mod.service.js";

function fakePrisma({ warningCount = 0, heldCount = 0, safeHistoryOnly = false } = {}) {
  function matchesRiskCategoryFilter(where = {}) {
    return Boolean(where.categories?.hasSome || where.case?.is?.categories?.hasSome);
  }

  return {
    moderationWarning: {
      count: async ({ where } = {}) => (safeHistoryOnly && matchesRiskCategoryFilter(where) ? 0 : warningCount),
      create: async ({ data }) => ({ id: "warning-test", ...data }),
    },
    moderationCase: {
      count: async ({ where } = {}) => (safeHistoryOnly && matchesRiskCategoryFilter(where) ? 0 : heldCount),
      create: async ({ data }) => ({ id: "case-test", ...data }),
      findUnique: async () => null,
      findMany: async () => [],
    },
    post: {
      update: async ({ data }) => ({ id: "post-test", ...data }),
    },
    postComment: {
      update: async ({ data }) => ({ id: "comment-test", ...data }),
    },
    $transaction: async (callback) => callback(fakePrisma({ warningCount, heldCount, safeHistoryOnly })),
  };
}

function config(values = {}) {
  return {
    get: (key) => values[key] ?? "",
  };
}

async function review(body, options = {}) {
  const service = new AutoModService(fakePrisma(options), config({ AUTOMOD_USE_LLM: "false" }));
  return service.review({
    targetType: "post",
    authorId: "user-test",
    title: "테스트",
    body,
  });
}

const cases = [
  {
    name: "safe art discussion is allowed",
    body: "이 작품의 색감과 구도가 정말 인상적이에요.",
    expectedAction: "allow",
  },
  {
    name: "mild harassment gets warning",
    body: "이 댓글은 너무 바보 같아요.",
    expectedAction: "warn",
  },
  {
    name: "direct contextual attack is held",
    body: "너 진짜 한심하다. 여기서 꺼져.",
    expectedAction: "hold",
  },
  {
    name: "spam links are held",
    body: "무료 이벤트 http://a.test http://b.test http://c.test 지금 클릭",
    expectedAction: "hold",
  },
  {
    name: "threat is reported",
    body: "너 죽어버려. 내가 찾아갈 거야.",
    expectedAction: "report",
  },
  {
    name: "prior warnings escalate a warning to hold",
    body: "이 글은 바보 같네요.",
    options: { warningCount: 3 },
    expectedAction: "hold",
  },
  {
    name: "clean comment is allowed despite prior history",
    body: "ㅋㅋ",
    options: { warningCount: 39, heldCount: 39 },
    expectedAction: "allow",
  },
  {
    name: "safe moderation history does not escalate a mild warning",
    body: "이 댓글은 너무 바보 같아요.",
    options: { warningCount: 39, heldCount: 39, safeHistoryOnly: true },
    expectedAction: "warn",
  },
];

for (const item of cases) {
  const decision = await review(item.body, item.options);
  assert.equal(decision.action, item.expectedAction, item.name);
  assert.ok(decision.categories.length > 0, `${item.name}: categories should be present`);
  assert.ok(decision.confidence >= 0 && decision.confidence <= 1, `${item.name}: confidence range`);
  console.log(`PASS ${item.name}: ${decision.action}`);
}
