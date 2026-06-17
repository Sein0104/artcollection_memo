import assert from "node:assert/strict";
import { PostsService } from "../dist/posts/posts.service.js";

const user = { id: "user-test", nickname: "tester", totalEarnedPoints: 40 };
const museum = { id: "museum-test", name: "Test Museum", scope: "test", country: "KR", area: "Seoul" };

const reportDecision = {
  action: "report",
  severity: 5,
  confidence: 0.9,
  categories: ["threat"],
  reason: "reported",
  evidence: {},
  authorMessage: "reported",
  adminSummary: "reported",
  model: "test",
};

const allowedDecision = {
  ...reportDecision,
  action: "allow",
  severity: 0,
  confidence: 0.7,
  categories: ["safe"],
  reason: "allowed",
  authorMessage: "",
  adminSummary: "allowed",
};

const warningDecision = {
  ...reportDecision,
  action: "warn",
  severity: 3,
  confidence: 0.75,
  categories: ["harassment"],
  reason: "warning",
  authorMessage: "warning notice",
  adminSummary: "warning",
};

const holdDecision = {
  ...reportDecision,
  action: "hold",
  severity: 4,
  confidence: 0.82,
  categories: ["harassment"],
  reason: "hold warning",
  authorMessage: "hold notice",
  adminSummary: "hold warning",
};

function makePrisma({ withComments = false } = {}) {
  const calls = {
    postCreate: 0,
    postUpdate: 0,
    commentCreate: 0,
    commentUpdate: 0,
  };
  const posts = [
    {
      id: "post-existing",
      authorId: user.id,
      author: user,
      title: "Existing title",
      body: "Existing body",
      boardType: "free",
      status: "published",
      museumId: museum.id,
      museum,
      upVotes: 0,
      downVotes: 0,
      comments: [],
      createdAt: new Date("2026-06-15T00:00:00Z"),
    },
  ];
  const comments = withComments
    ? [
        {
          id: "comment-parent",
          postId: "post-existing",
          authorId: user.id,
          parentId: null,
          body: "Original comment",
          status: "published",
          author: user,
          createdAt: new Date("2026-06-15T01:00:00Z"),
        },
        {
          id: "comment-reply",
          postId: "post-existing",
          authorId: "other-user",
          parentId: "comment-parent",
          body: "Reply stays",
          status: "published",
          author: { id: "other-user", nickname: "other", totalEarnedPoints: 0 },
          createdAt: new Date("2026-06-15T01:01:00Z"),
        },
      ]
    : [];

  function attachPost(post) {
    return {
      ...post,
      comments: comments.filter((comment) => comment.postId === post.id && comment.status === "published"),
    };
  }

  return {
    calls,
    post: {
      findMany: async () => posts.filter((post) => post.status === "published").map(attachPost),
      findUnique: async ({ where }) => {
        const post = posts.find((item) => item.id === where.id);
        return post ? attachPost(post) : null;
      },
      create: async ({ data }) => {
        calls.postCreate += 1;
        const post = {
          id: `post-${calls.postCreate}`,
          authorId: data.authorId,
          author: user,
          title: data.title,
          body: data.body,
          boardType: data.boardType,
          status: data.status,
          museumId: data.museumId,
          museum,
          upVotes: 0,
          downVotes: 0,
          comments: [],
          createdAt: new Date(),
        };
        posts.unshift(post);
        return post;
      },
      update: async ({ where, data }) => {
        calls.postUpdate += 1;
        const post = posts.find((item) => item.id === where.id);
        Object.assign(post, data);
        return post;
      },
    },
    postComment: {
      findUnique: async ({ where }) => comments.find((comment) => comment.id === where.id) ?? null,
      create: async ({ data }) => {
        calls.commentCreate += 1;
        const comment = {
          id: `comment-${calls.commentCreate}`,
          ...data,
          author: user,
          createdAt: new Date(),
        };
        comments.push(comment);
        return comment;
      },
      update: async ({ where, data }) => {
        calls.commentUpdate += 1;
        const comment = comments.find((item) => item.id === where.id);
        Object.assign(comment, data);
        return comment;
      },
    },
    museum: {
      upsert: async () => museum,
    },
  };
}

function auth() {
  return {
    requireUserFromCookie: async () => user,
  };
}

// Tags are supplied by the author only; missing tags stay empty without network calls.
function config() {
  return {
    get: () => "",
  };
}

function autoMod(decision) {
  const cases = [];
  const reviewInputs = [];
  return {
    cases,
    reviewInputs,
    review: async (input) => {
      reviewInputs.push(input);
      return decision;
    },
    isBlockingAction: (action) => action === "report",
    publicStatusFor: (action) => (action === "report" ? "held" : "published"),
    noticeFor: (item) => ({
      action: item.action,
      severity: item.severity,
      confidence: item.confidence,
      categories: item.categories,
      authorMessage: item.action === "report" ? "blocked notice" : item.authorMessage,
    }),
    recordCase: async (item) => {
      cases.push(item);
      return item;
    },
  };
}

async function testReportCreateDoesNotPersist() {
  const prisma = makePrisma();
  const mod = autoMod(reportDecision);
  const service = new PostsService(prisma, auth(), mod, config());

  const result = await service.create({ title: "Bad", body: "Bad body", museumId: museum.id, boardType: "free" });

  assert.equal(prisma.calls.postCreate, 0);
  assert.equal(result.posts.length, 1);
  assert.equal(result.moderation.action, "report");
  assert.equal(mod.cases.length, 1);
  assert.equal(mod.cases[0].status, "resolved");
  console.log("PASS report post create is preflight-only");
}

async function testAllowedCreatePersists() {
  const prisma = makePrisma();
  const mod = autoMod(allowedDecision);
  const service = new PostsService(prisma, auth(), mod, config());

  const result = await service.create({ title: "Good", body: "Good body", museumId: museum.id, boardType: "free" });

  assert.equal(prisma.calls.postCreate, 1);
  assert.equal(result.posts.length, 2);
  assert.equal(mod.cases.length, 1);
  assert.equal(mod.cases[0].status, undefined);
  console.log("PASS allowed post create persists");
}

async function testWarningCreatePersistsWithNotice() {
  const prisma = makePrisma();
  const mod = autoMod(warningDecision);
  const service = new PostsService(prisma, auth(), mod, config());

  const result = await service.create({ title: "Warn", body: "Warning body", museumId: museum.id, boardType: "free" });

  assert.equal(prisma.calls.postCreate, 1);
  assert.equal(result.posts.length, 2);
  assert.equal(result.posts[0].status, "published");
  assert.equal(result.moderation.action, "warn");
  assert.equal(result.moderation.authorMessage, "warning notice");
  assert.equal(mod.cases.length, 1);
  assert.equal(mod.cases[0].status, undefined);
  console.log("PASS warning post create persists with notice");
}

async function testHoldCreatePersistsWithNotice() {
  const prisma = makePrisma();
  const mod = autoMod(holdDecision);
  const service = new PostsService(prisma, auth(), mod, config());

  const result = await service.create({ title: "Hold", body: "Hold body", museumId: museum.id, boardType: "free" });

  assert.equal(prisma.calls.postCreate, 1);
  assert.equal(result.posts.length, 2);
  assert.equal(result.posts[0].status, "published");
  assert.equal(result.moderation.action, "hold");
  assert.equal(result.moderation.authorMessage, "hold notice");
  assert.equal(mod.cases.length, 1);
  assert.equal(mod.cases[0].status, undefined);
  console.log("PASS hold post create persists with notice");
}

async function testReportCommentDoesNotPersist() {
  const prisma = makePrisma();
  const mod = autoMod(reportDecision);
  const service = new PostsService(prisma, auth(), mod, config());

  const result = await service.comment("post-existing", { body: "Bad comment" });

  assert.equal(prisma.calls.commentCreate, 0);
  assert.equal(result.post.commentCount, 0);
  assert.equal(result.moderation.action, "report");
  assert.equal(mod.cases[0].status, "resolved");
  assert.equal(mod.reviewInputs[0].useLlm, undefined);
  console.log("PASS report comment is preflight-only");
}

async function testWarningCommentPersistsWithNotice() {
  const prisma = makePrisma();
  const mod = autoMod(warningDecision);
  const service = new PostsService(prisma, auth(), mod, config());

  const result = await service.comment("post-existing", { body: "Warning comment" });

  assert.equal(prisma.calls.commentCreate, 1);
  assert.equal(result.post.commentCount, 1);
  assert.equal(result.moderation.action, "warn");
  assert.equal(mod.cases[0].status, undefined);
  assert.equal(mod.reviewInputs[0].useLlm, undefined);
  console.log("PASS warning comment persists with notice");
}

async function testDeleteCommentSoftDeletesAndKeepsReplies() {
  const prisma = makePrisma({ withComments: true });
  const mod = autoMod(allowedDecision);
  const service = new PostsService(prisma, auth(), mod, config());

  const result = await service.removeComment("post-existing", "comment-parent");

  assert.equal(prisma.calls.commentUpdate, 1);
  assert.equal(result.post.comments.length, 1);
  assert.equal(result.post.comments[0].body, "삭제된 댓글입니다.");
  assert.equal(result.post.comments[0].replies.length, 1);
  assert.equal(result.post.comments[0].replies[0].body, "Reply stays");
  console.log("PASS comment delete is a soft-delete and keeps replies");
}

async function testReportUpdateDoesNotMutatePost() {
  const prisma = makePrisma();
  const mod = autoMod(reportDecision);
  const service = new PostsService(prisma, auth(), mod, config());

  const result = await service.update("post-existing", { title: "Changed", body: "Bad update" });

  assert.equal(prisma.calls.postUpdate, 0);
  assert.equal(result.post.title, "Existing title");
  assert.equal(result.moderation.action, "report");
  assert.equal(mod.cases[0].status, "resolved");
  console.log("PASS report post update is preflight-only");
}

async function testWarningUpdateMutatesPostWithNotice() {
  const prisma = makePrisma();
  const mod = autoMod(warningDecision);
  const service = new PostsService(prisma, auth(), mod, config());

  const result = await service.update("post-existing", { title: "Changed", body: "Warning update" });

  assert.equal(prisma.calls.postUpdate, 1);
  assert.equal(result.post.title, "Changed");
  assert.equal(result.moderation.action, "warn");
  assert.equal(mod.cases[0].status, undefined);
  console.log("PASS warning post update persists with notice");
}

await testReportCreateDoesNotPersist();
await testAllowedCreatePersists();
await testWarningCreatePersistsWithNotice();
await testHoldCreatePersistsWithNotice();
await testReportCommentDoesNotPersist();
await testWarningCommentPersistsWithNotice();
await testDeleteCommentSoftDeletesAndKeepsReplies();
await testReportUpdateDoesNotMutatePost();
await testWarningUpdateMutatesPostWithNotice();
