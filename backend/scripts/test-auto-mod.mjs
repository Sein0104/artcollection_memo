import assert from "node:assert/strict";
import { AutoModService } from "../dist/auto-mod/auto-mod.service.js";

function fakePrisma({
  warningCount = 0,
  heldCount = 0,
  safeHistoryOnly = false,
  post = { title: "Gallery etiquette", body: "Please keep critique focused on the artwork." },
  parentComment = { body: "I think the brushwork is careful and balanced." },
  recentComments = [],
} = {}) {
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
      findUnique: async () => post,
      update: async ({ data }) => ({ id: "post-test", ...data }),
    },
    postComment: {
      findUnique: async () => parentComment,
      findMany: async () => recentComments,
      update: async ({ data }) => ({ id: "comment-test", ...data }),
    },
    $transaction: async (callback) => callback(fakePrisma({ warningCount, heldCount, safeHistoryOnly, post, parentComment, recentComments })),
  };
}

function config(values = {}) {
  return {
    get: (key) => values[key] ?? "",
  };
}

async function review(input, options = {}) {
  const service = new AutoModService(
    fakePrisma(options),
    config(options.enableLlm ? { OPENAI_API_KEY: "test-key", AUTOMOD_USE_LLM: "true" } : { AUTOMOD_USE_LLM: "false" }),
  );
  if (options.llmDecision) {
    service.llmContextJudge = async () => options.llmDecision;
  }
  const payload =
    typeof input === "string"
      ? {
          targetType: "post",
          authorId: "user-test",
          title: "Test post",
          body: input,
        }
      : {
          authorId: "user-test",
          title: "Test post",
          ...input,
        };
  return service.review(payload);
}

function assertPlannerEvidence(decision, item) {
  const agent = decision.evidence?.agent;
  assert.equal(agent?.planner, "dynamic-rule-planner-v1", `${item.name}: dynamic planner should be recorded`);
  assert.ok(agent.availableTools.some((tool) => tool.name === "thread_context_check"), `${item.name}: thread context tool should be available`);

  const steps = agent.steps;
  assert.ok(Array.isArray(steps) && steps.length > 0, `${item.name}: agent steps should be recorded`);
  assert.ok(steps.every((step) => typeof step.plannerReason === "string" && step.plannerReason.length > 0), `${item.name}: each step needs a planner reason`);

  const names = steps.map((step) => step.tool);
  if (item.expectedSteps) assert.deepEqual(names, item.expectedSteps, `${item.name}: tool path`);
  for (const absentTool of item.absentSteps ?? []) {
    assert.ok(!names.includes(absentTool), `${item.name}: ${absentTool} should not run`);
  }
}

const cases = [
  {
    name: "safe art discussion is allowed without history lookup",
    input: "I liked the composition and the warm lighting in this painting.",
    expectedAction: "allow",
    expectedSteps: ["rule_check", "decide_action"],
    absentSteps: ["history_check", "thread_context_check", "llm_judge"],
  },
  {
    name: "mild harassment checks author history before warning",
    input: "This take is stupid.",
    expectedAction: "warn",
    expectedSteps: ["rule_check", "history_check", "decide_action"],
  },
  {
    name: "korean profanity checks author history before warning",
    input: "야 씨발아",
    expectedAction: "warn",
    expectedSteps: ["rule_check", "history_check", "decide_action"],
    expectedCategory: "harassment",
  },
  {
    name: "llm catches uncatalogued contextual insult",
    input: "너 진짜 별로야",
    options: {
      enableLlm: true,
      llmDecision: {
        action: "warn",
        severity: 3,
        confidence: 0.86,
        categories: ["harassment"],
        reason: "contextual insult not covered by deterministic keyword list",
        authorMessage: "warning notice",
        adminSummary: "contextual insult",
      },
    },
    expectedAction: "warn",
    expectedSteps: ["rule_check", "llm_judge", "history_check", "decide_action"],
    expectedCategory: "harassment",
  },
  {
    name: "spam links are held",
    input: "Free event http://a.test http://b.test http://c.test click now",
    expectedAction: "hold",
    expectedSteps: ["rule_check", "history_check", "decide_action"],
  },
  {
    name: "threat is reported immediately",
    input: "I will kill you if you post this again.",
    expectedAction: "report",
    expectedSteps: ["rule_check", "decide_action"],
    absentSteps: ["history_check", "thread_context_check", "llm_judge"],
  },
  {
    name: "prior warnings keep a mild issue at warn severity",
    input: "This post is stupid.",
    options: { warningCount: 3 },
    expectedAction: "warn",
    expectedSteps: ["rule_check", "history_check", "decide_action"],
  },
  {
    name: "prior held cases escalate a mild warning to hold",
    input: "This post is stupid.",
    options: { heldCount: 2 },
    expectedAction: "hold",
    expectedSteps: ["rule_check", "history_check", "decide_action"],
  },
  {
    name: "llm hold for mild harassment is bounded to warning",
    input: "This post is stupid.",
    options: {
      enableLlm: true,
      llmDecision: {
        action: "hold",
        severity: 4,
        confidence: 0.9,
        categories: ["harassment"],
        reason: "llm wanted hold",
        authorMessage: "warning notice",
        adminSummary: "llm wanted hold",
      },
    },
    expectedAction: "warn",
    expectedSteps: ["rule_check", "history_check", "llm_judge", "decide_action"],
  },
  {
    name: "clean post is allowed despite prior history",
    input: "Thanks for sharing the exhibition notes.",
    options: { warningCount: 39, heldCount: 39 },
    expectedAction: "allow",
    expectedSteps: ["rule_check", "decide_action"],
    absentSteps: ["history_check"],
  },
  {
    name: "safe moderation history does not escalate a mild warning",
    input: "This framing is stupid.",
    options: { warningCount: 39, heldCount: 39, safeHistoryOnly: true },
    expectedAction: "warn",
    expectedSteps: ["rule_check", "history_check", "decide_action"],
  },
  {
    name: "comment reply uses thread context before deciding",
    input: {
      targetType: "comment",
      authorId: "user-test",
      body: "Sure, genius lol",
      postId: "post-test",
      parentId: "comment-parent",
      useLlm: false,
    },
    options: {
      parentComment: { body: "I tried to explain my interpretation carefully." },
      recentComments: [{ body: "Please keep it civil." }, { body: "The original point was about color." }],
    },
    expectedAction: "warn",
    expectedSteps: ["rule_check", "thread_context_check", "history_check", "decide_action"],
    expectedCategory: "contextual_attack",
    expectedSignal: "possible_contextual_sarcasm",
  },
];

for (const item of cases) {
  const decision = await review(item.input, item.options);
  assert.equal(decision.action, item.expectedAction, item.name);
  assert.ok(decision.categories.length > 0, `${item.name}: categories should be present`);
  assert.ok(decision.confidence >= 0 && decision.confidence <= 1, `${item.name}: confidence range`);
  if (item.expectedCategory) assert.ok(decision.categories.includes(item.expectedCategory), `${item.name}: expected category`);
  if (item.expectedSignal) assert.ok(decision.evidence.threadContext.signals.includes(item.expectedSignal), `${item.name}: expected thread signal`);
  assertPlannerEvidence(decision, item);
  console.log(`PASS ${item.name}: ${decision.action}`);
}
