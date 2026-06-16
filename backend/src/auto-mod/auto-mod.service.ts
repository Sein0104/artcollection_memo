import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";

export type AutoModAction = "allow" | "warn" | "hold" | "report";
export type AutoModTargetType = "post" | "comment";

export type AutoModDecision = {
  action: AutoModAction;
  severity: number;
  confidence: number;
  categories: string[];
  reason: string;
  evidence: Record<string, unknown>;
  authorMessage: string;
  adminSummary: string;
  model: string;
};

type AutoModInput = {
  targetType: AutoModTargetType;
  authorId: string;
  title?: string;
  body: string;
  postId?: string;
  parentId?: string;
  useLlm?: boolean;
};

type RuleFinding = {
  category: string;
  severity: number;
  confidence: number;
  reason: string;
  matched: string;
};

type AutoModContext = {
  warningCount30d: number;
  heldOrReportedCount30d: number;
};

type AutoModAgentToolName = "rule_check" | "history_check" | "llm_judge" | "decide_action";

type AutoModAgentStep = {
  step: number;
  tool: AutoModAgentToolName;
  status: "completed" | "skipped" | "failed";
  summary: string;
  output?: Record<string, unknown>;
};

type AutoModState = {
  input: AutoModInput;
  normalizedText: string;
  findings: RuleFinding[];
  context: AutoModContext;
  llmDecision?: Partial<AutoModDecision>;
  steps: AutoModAgentStep[];
};

const AUTOMOD_TIMEOUT_MS = 20_000;
const AUTOMOD_MAX_AGENT_STEPS = 4;
const VALID_ACTIONS = new Set<AutoModAction>(["allow", "warn", "hold", "report"]);
const AUTOMOD_AGENT_TOOLS: Array<{ name: AutoModAgentToolName; description: string }> = [
  { name: "rule_check", description: "Run deterministic keyword, spam, privacy, and threat checks." },
  { name: "history_check", description: "Load recent moderation warnings and held/reported cases for the author." },
  { name: "llm_judge", description: "Ask the configured LLM for contextual moderation judgment when enabled." },
  { name: "decide_action", description: "Combine tool outputs into the final moderation action." },
];
const HISTORY_RISK_CATEGORIES = [
  "spam",
  "threat",
  "privacy",
  "privacy_risk",
  "account_security",
  "credential-exposure",
  "security-risk",
  "contextual_attack",
  "harassment",
  "insult",
];
const AUTOMOD_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["allow", "warn", "hold", "report"] },
    severity: { type: "integer", minimum: 0, maximum: 5 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    categories: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
    authorMessage: { type: "string" },
    adminSummary: { type: "string" },
  },
  required: ["action", "severity", "confidence", "categories", "reason", "authorMessage", "adminSummary"],
};

@Injectable()
export class AutoModService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async review(input: AutoModInput): Promise<AutoModDecision> {
    const state: AutoModState = {
      input,
      normalizedText: this.normalizeContent(input),
      findings: [],
      context: { warningCount30d: 0, heldOrReportedCount30d: 0 },
      steps: [],
    };

    return this.runAgentLoop(state);
  }

  private async runAgentLoop(state: AutoModState) {
    const executedTools = new Set<AutoModAgentToolName>();

    for (let step = 1; step <= AUTOMOD_MAX_AGENT_STEPS; step += 1) {
      const tool = this.chooseNextAgentTool(executedTools);
      if (!tool) break;
      executedTools.add(tool);

      const decision = await this.executeAgentTool(tool, state, step);
      if (decision) return decision;
    }

    this.addAgentStep(state, {
      step: state.steps.length + 1,
      tool: "decide_action",
      status: "completed",
      summary: "Fallback decision executed after agent loop ended.",
    });
    return this.decideAction(state);
  }

  private chooseNextAgentTool(executedTools: Set<AutoModAgentToolName>) {
    return AUTOMOD_AGENT_TOOLS.map((tool) => tool.name).find((tool) => !executedTools.has(tool));
  }

  private async executeAgentTool(tool: AutoModAgentToolName, state: AutoModState, step: number): Promise<AutoModDecision | null> {
    try {
      if (tool === "rule_check") {
        const beforeCount = state.findings.length;
        this.rulePrecheck(state);
        this.addAgentStep(state, {
          step,
          tool,
          status: "completed",
          summary: "Rule precheck completed.",
          output: { findingsAdded: state.findings.length - beforeCount, findingCount: state.findings.length },
        });
        return null;
      }

      if (tool === "history_check") {
        state.context = await this.loadContext(state.input.authorId);
        this.addAgentStep(state, {
          step,
          tool,
          status: "completed",
          summary: "Author moderation context loaded.",
          output: state.context,
        });
        return null;
      }

      if (tool === "llm_judge") {
        if (state.input.useLlm === false || !this.shouldUseLlm()) {
          this.addAgentStep(state, {
            step,
            tool,
            status: "skipped",
            summary: "LLM judgment skipped because it is disabled or not configured.",
            output: { configured: this.shouldUseLlm(), requested: state.input.useLlm !== false },
          });
          return null;
        }

        state.llmDecision = await this.llmContextJudge(state).catch((error) => ({
          categories: ["llm_unavailable"],
          reason: error instanceof Error ? error.message : "llm_unavailable",
          model: this.modelName(),
        }));
        this.addAgentStep(state, {
          step,
          tool,
          status: "completed",
          summary: "LLM contextual judgment completed.",
          output: {
            action: state.llmDecision.action,
            severity: state.llmDecision.severity,
            categories: state.llmDecision.categories,
          },
        });
        return null;
      }

      this.addAgentStep(state, {
        step,
        tool,
        status: "completed",
        summary: "Final moderation decision composed.",
      });
      return this.decideAction(state);
    } catch (error) {
      this.addAgentStep(state, {
        step,
        tool,
        status: "failed",
        summary: error instanceof Error ? error.message : "agent_tool_failed",
      });
      throw error;
    }
  }

  private addAgentStep(state: AutoModState, step: AutoModAgentStep) {
    state.steps.push(step);
  }

  async recordCase({
    targetType,
    targetId,
    postId,
    commentId,
    authorId,
    decision,
    status,
  }: {
    targetType: AutoModTargetType;
    targetId: string;
    postId?: string;
    commentId?: string;
    authorId: string;
    decision: AutoModDecision;
    status?: string;
  }) {
    const caseStatus = status ?? (decision.action === "hold" || decision.action === "report" ? "open" : "resolved");
    const moderationCase = await this.prisma.moderationCase.create({
      data: {
        targetType,
        targetId,
        postId,
        commentId,
        authorId,
        action: decision.action,
        severity: decision.severity,
        confidence: decision.confidence,
        categories: decision.categories,
        reason: decision.reason,
        evidence: decision.evidence as Prisma.InputJsonValue,
        authorMessage: decision.authorMessage,
        adminSummary: decision.adminSummary,
        model: decision.model,
        status: caseStatus,
      },
    });

    if (decision.action !== "allow" && decision.authorMessage) {
      await this.prisma.moderationWarning.create({
        data: {
          userId: authorId,
          caseId: moderationCase.id,
          message: decision.authorMessage,
        },
      });
    }

    return moderationCase;
  }

  publicStatusFor(action: AutoModAction) {
    return action === "hold" || action === "report" ? "held" : "published";
  }

  noticeFor(decision: AutoModDecision) {
    return {
      action: decision.action,
      severity: decision.severity,
      confidence: decision.confidence,
      categories: decision.categories,
      authorMessage: this.noticeMessageFor(decision),
    };
  }

  isBlockingAction(action: AutoModAction) {
    return action === "hold" || action === "report";
  }

  async listCases(status = "open") {
    const cases = await this.prisma.moderationCase.findMany({
      where: status === "all" ? {} : { status },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        author: true,
        post: { include: { museum: true } },
        comment: { include: { post: true } },
      },
    });

    return {
      cases: cases.map((item) => ({
        id: item.id,
        targetType: item.targetType,
        targetId: item.targetId,
        action: item.action,
        severity: item.severity,
        confidence: item.confidence,
        categories: item.categories,
        reason: item.reason,
        authorMessage: item.authorMessage,
        adminSummary: item.adminSummary,
        status: item.status,
        reviewerNote: item.reviewerNote,
        createdAt: item.createdAt,
        author: item.author.nickname,
        content:
          item.targetType === "post"
            ? {
                title: item.post?.title ?? "",
                body: item.post?.body ?? "",
                museumName: item.post?.museum?.name ?? "",
              }
            : {
                title: item.comment?.post?.title ?? "",
                body: item.comment?.body ?? "",
                museumName: "",
              },
      })),
    };
  }

  async reviewCase(caseId: string, decision: "approve" | "reject" | "resolve", reviewerNote = "") {
    const moderationCase = await this.prisma.moderationCase.findUnique({ where: { id: caseId } });
    if (!moderationCase) return null;

    const targetStatus = decision === "approve" ? "published" : decision === "reject" ? "rejected" : undefined;
    const caseStatus = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "resolved";

    await this.prisma.$transaction(async (tx) => {
      if (targetStatus && moderationCase.postId) {
        await tx.post.update({ where: { id: moderationCase.postId }, data: { status: targetStatus } });
      }
      if (targetStatus && moderationCase.commentId) {
        await tx.postComment.update({ where: { id: moderationCase.commentId }, data: { status: targetStatus } });
      }
      await tx.moderationCase.update({
        where: { id: caseId },
        data: {
          status: caseStatus,
          reviewedAt: new Date(),
          reviewerNote,
        },
      });
    });

    return this.listCases("open");
  }

  private normalizeContent(input: AutoModInput) {
    return [input.title, input.body].filter(Boolean).join("\n").normalize("NFKC").replace(/\s+/g, " ").trim();
  }

  private rulePrecheck(state: AutoModState) {
    const text = state.normalizedText;
    const lower = text.toLowerCase();
    const add = (finding: RuleFinding) => state.findings.push(finding);
    const urlCount = (text.match(/https?:\/\//gi) ?? []).length;

    if (urlCount >= 3) {
      add({
        category: "spam",
        severity: 4,
        confidence: 0.92,
        reason: "짧은 게시글에 외부 링크가 과도하게 포함되어 있습니다.",
        matched: "url_count",
      });
    }

    if (/(.)\1{8,}/u.test(text)) {
      add({
        category: "spam",
        severity: 3,
        confidence: 0.82,
        reason: "반복 문자가 과도하게 포함되어 도배성 게시물로 보입니다.",
        matched: "repeated_character",
      });
    }

    if (/죽어버려|죽여버|kill yourself|i will kill|살해|협박/i.test(text)) {
      add({
        category: "threat",
        severity: 5,
        confidence: 0.96,
        reason: "상대에게 위해를 암시하거나 협박하는 표현이 포함되어 있습니다.",
        matched: "threat_pattern",
      });
    }

    if (/전화번호|집주소|신상\s*공개|개인정보|doxx/i.test(text)) {
      add({
        category: "privacy_risk",
        severity: 5,
        confidence: 0.9,
        reason: "개인정보 노출 또는 신상 공개 위험이 있는 표현이 포함되어 있습니다.",
        matched: "privacy_pattern",
      });
    }

    if (/(너|당신|작성자|쟤|걔|운영자).{0,24}(멍청|한심|꺼져|역겹|stupid|idiot|trash|shut up)/iu.test(text)) {
      add({
        category: "contextual_attack",
        severity: 4,
        confidence: 0.88,
        reason: "특정 상대를 향한 맥락적 조롱 또는 공격 표현으로 판단됩니다.",
        matched: "directed_attack_pattern",
      });
    } else if (/바보|멍청|한심|꺼져|stupid|idiot|shut up/i.test(lower)) {
      add({
        category: "harassment",
        severity: 3,
        confidence: 0.75,
        reason: "공격적인 표현이 포함되어 작성자에게 주의가 필요합니다.",
        matched: "harassment_keyword",
      });
    }
  }

  private async loadContext(authorId: string): Promise<AutoModContext> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [warningCount30d, heldOrReportedCount30d] = await Promise.all([
      this.prisma.moderationWarning.count({
        where: {
          userId: authorId,
          createdAt: { gte: since },
          case: {
            is: {
              categories: { hasSome: HISTORY_RISK_CATEGORIES },
            },
          },
        },
      }),
      this.prisma.moderationCase.count({
        where: {
          authorId,
          createdAt: { gte: since },
          action: { in: ["hold", "report"] },
          categories: { hasSome: HISTORY_RISK_CATEGORIES },
        },
      }),
    ]);
    return { warningCount30d, heldOrReportedCount30d };
  }

  private async llmContextJudge(state: AutoModState): Promise<Partial<AutoModDecision>> {
    const apiKey = this.config.get<string>("OPENAI_API_KEY")?.trim();
    if (!apiKey) return {};

    const prompt = [
      "You are an Auto-Mod Agent for a Korean art community board.",
      "Judge whether the content is safe to publish. Consider contextual attacks, spam, threats, privacy risk, and harassment.",
      "Return only JSON with action, severity, confidence, categories, reason, authorMessage, adminSummary.",
      "Valid actions: allow, warn, hold, report.",
      "",
      `Target: ${state.input.targetType}`,
      `Prior warnings in 30 days: ${state.context.warningCount30d}`,
      `Prior held/reported cases in 30 days: ${state.context.heldOrReportedCount30d}`,
      `Rule findings: ${JSON.stringify(state.findings)}`,
      `Content: ${state.normalizedText}`,
    ].join("\n");

    const response = await this.fetchWithTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelName(),
          input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          text: {
            format: {
              type: "json_schema",
              name: "auto_mod_decision",
              strict: true,
              schema: AUTOMOD_RESPONSE_JSON_SCHEMA,
            },
          },
        }),
      },
      AUTOMOD_TIMEOUT_MS,
    );

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return { categories: ["llm_unavailable"], reason: "automod_llm_failed", model: this.modelName() };
    return this.sanitizeLlmDecision(this.parseJsonObject(this.extractOutputText(payload)));
  }

  private decideAction(state: AutoModState): AutoModDecision {
    const strongest = [...state.findings].sort((left, right) => right.severity - left.severity || right.confidence - left.confidence)[0];
    const llmAction = this.validAction(state.llmDecision?.action) ? (state.llmDecision?.action as AutoModAction) : undefined;
    const baseSeverity = this.clampInt(Number(state.llmDecision?.severity ?? strongest?.severity ?? 0), 0, 5);
    const escalatedSeverity = Math.min(5, baseSeverity + (state.context.warningCount30d >= 2 ? 1 : 0));
    const categories = this.unique([
      ...(strongest ? state.findings.map((finding) => finding.category) : []),
      ...this.stringArray(state.llmDecision?.categories),
    ]);
    const hasCurrentRiskSignal = Boolean(strongest) || Boolean(llmAction && llmAction !== "allow");

    let action: AutoModAction = llmAction ?? "allow";
    if (!llmAction) {
      if (escalatedSeverity >= 5 || categories.includes("threat") || categories.includes("privacy_risk")) action = "report";
      else if (escalatedSeverity >= 4 || (hasCurrentRiskSignal && state.context.heldOrReportedCount30d >= 2)) action = "hold";
      else if (escalatedSeverity >= 3 || categories.includes("harassment")) action = "warn";
    }

    if (hasCurrentRiskSignal && action === "allow" && escalatedSeverity >= 3) action = "warn";
    if (hasCurrentRiskSignal && action === "warn" && (escalatedSeverity >= 4 || state.context.warningCount30d >= 3)) action = "hold";
    if (action === "hold" && escalatedSeverity >= 5) action = "report";

    const reason =
      this.nonEmptyString(state.llmDecision?.reason) ||
      strongest?.reason ||
      "커뮤니티 규칙 위반 신호가 낮아 게시를 허용했습니다.";
    const authorMessage =
      this.nonEmptyString(state.llmDecision?.authorMessage) ||
      this.defaultAuthorMessage(action);
    const adminSummary =
      this.nonEmptyString(state.llmDecision?.adminSummary) ||
      this.defaultAdminSummary(action, reason);

    return {
      action,
      severity: escalatedSeverity,
      confidence: this.clampNumber(Number(state.llmDecision?.confidence ?? strongest?.confidence ?? 0.62), 0, 1),
      categories: categories.length ? categories : ["safe"],
      reason,
      authorMessage,
      adminSummary,
      model: this.nonEmptyString(state.llmDecision?.model) || (this.shouldUseLlm() ? this.modelName() : "automod-rules-v1"),
      evidence: {
        graph: ["normalizeContent", "rulePrecheck", "loadContext", "llmContextJudge", "decideAction", "auditLog"],
        agent: {
          maxSteps: AUTOMOD_MAX_AGENT_STEPS,
          availableTools: AUTOMOD_AGENT_TOOLS,
          steps: state.steps,
        },
        findings: state.findings,
        context: state.context,
      },
    };
  }

  private shouldUseLlm() {
    const explicit = this.config.get<string>("AUTOMOD_USE_LLM")?.toLowerCase();
    if (explicit === "false") return false;
    return Boolean(this.config.get<string>("OPENAI_API_KEY")?.trim());
  }

  private modelName() {
    return (
      this.config.get<string>("AUTOMOD_MODEL") ||
      this.config.get<string>("OPENAI_DOCENT_MODEL") ||
      this.config.get<string>("OPENAI_VISION_MODEL") ||
      "gpt-5.4-mini"
    );
  }

  private validAction(value: unknown) {
    return typeof value === "string" && VALID_ACTIONS.has(value as AutoModAction);
  }

  private sanitizeLlmDecision(value: Record<string, unknown>): Partial<AutoModDecision> {
    return {
      action: this.validAction(value.action) ? (value.action as AutoModAction) : undefined,
      severity: this.clampInt(Number(value.severity ?? 0), 0, 5),
      confidence: this.clampNumber(Number(value.confidence ?? 0), 0, 1),
      categories: this.stringArray(value.categories),
      reason: this.nonEmptyString(value.reason),
      authorMessage: this.nonEmptyString(value.authorMessage),
      adminSummary: this.nonEmptyString(value.adminSummary),
      model: this.modelName(),
      evidence: {},
    };
  }

  private defaultAuthorMessage(action: AutoModAction) {
    if (action === "warn") return "표현을 조금 부드럽게 수정하면 더 좋은 대화가 될 수 있어요.";
    if (action === "hold" || action === "report") return "비하, 모욕, 위협, 개인정보 노출 위험이 감지되어 업로드되지 않았어요. 표현을 수정한 뒤 다시 시도해주세요.";
    return "";
  }

  private noticeMessageFor(decision: AutoModDecision) {
    if (this.isBlockingAction(decision.action)) {
      return "비하, 모욕, 위협, 개인정보 노출 위험이 감지되어 업로드되지 않았어요. 표현을 수정한 뒤 다시 시도해주세요.";
    }
    return decision.authorMessage;
  }

  private defaultAdminSummary(action: AutoModAction, reason: string) {
    if (action === "allow") return "자동 검토 결과 게시 허용";
    return reason;
  }

  private stringArray(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  }

  private unique(values: string[]) {
    return [...new Set(values.filter(Boolean))];
  }

  private nonEmptyString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }

  private clampInt(value: number, min: number, max: number) {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  private clampNumber(value: number, min: number, max: number) {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  private async fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractOutputText(payload: Record<string, unknown>) {
    const outputText = payload.output_text;
    if (typeof outputText === "string") return outputText;

    const output = Array.isArray(payload.output) ? payload.output : [];
    return output
      .flatMap((item) => (Array.isArray((item as { content?: unknown }).content) ? ((item as { content: unknown[] }).content) : []))
      .map((item) => {
        const record = item as { text?: unknown };
        return typeof record.text === "string" ? record.text : "";
      })
      .join("\n");
  }

  private parseJsonObject(text: string) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return {};
      const parsed = JSON.parse(match[0]) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    }
  }
}
