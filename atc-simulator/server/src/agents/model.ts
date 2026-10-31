// Model adapters (plan Task 6). OpenAIModelAdapter makes one structured-output call per job;
// RulesModelAdapter wraps the deterministic policy and is always labelled RULES_FALLBACK.
// No model identifier is hard-coded: OPENAI_MODEL is required in live mode.
import OpenAI from "openai"
import type { AgentDecision, AgentDecisionInput, DecisionSource, DependencyHealth, ModelAdapter } from "@ghost-tower/domain/contracts"
import { MODEL_TIMEOUT_MS } from "@ghost-tower/domain/constants"
import { buildModelRequest } from "./prompts.ts"
import { ModelOutputError, parseModelOutput } from "./tools.ts"

export interface AgentModel extends ModelAdapter {
    // MODEL for a live LLM. RULES_FALLBACK for the deterministic policy, so a rules decision
    // is never presented as a model decision.
    readonly source: DecisionSource
    readonly label: string
}

// Deterministic valid-action policy (packages/domain/src/policy.ts, chooseValidAction).
export type FallbackPolicy = (input: AgentDecisionInput) => AgentDecision

export type ModelUsage = { model: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null }

// The slice of the OpenAI client this adapter uses; tests inject a fake.
export type ResponsesClient = {
    responses: {
        create(body: Record<string, unknown>, options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }): PromiseLike<{
            status?: string | null
            output_text?: string
            output?: unknown[]
            usage?: { input_tokens?: number; output_tokens?: number } | null
            incomplete_details?: { reason?: string } | null
        }>
    }
}

export type ReasoningEffortSetting = "none" | "minimal" | "low" | "medium" | "high" | "omit"

export type OpenAIAdapterOptions = {
    model: string
    apiKey?: string
    client?: ResponsesClient
    reasoningEffort?: ReasoningEffortSetting
    timeoutMs?: number
    maxOutputTokens?: number
    onUsage?: (usage: ModelUsage) => void
}

export class OpenAIModelAdapter implements AgentModel {
    readonly source = "MODEL" as const
    readonly label: string
    private readonly client: ResponsesClient
    private readonly opts: OpenAIAdapterOptions

    constructor(opts: OpenAIAdapterOptions) {
        if (!opts.model) throw new Error("OPENAI_MODEL is required for live agents")
        if (!opts.client && !opts.apiKey) throw new Error("OPENAI_API_KEY is required for live agents")
        this.opts = opts
        this.label = opts.model
        this.client = opts.client ?? (new OpenAI({ apiKey: opts.apiKey, maxRetries: 0 }) as unknown as ResponsesClient)
    }

    async decide(input: AgentDecisionInput, signal: AbortSignal): Promise<AgentDecision> {
        const req = buildModelRequest(input)
        const effort = this.opts.reasoningEffort ?? "none"
        const body: Record<string, unknown> = {
            model: this.opts.model,
            instructions: req.instructions,
            input: req.userContent,
            text: { format: { type: "json_schema", name: req.schemaName, schema: req.schema, strict: true } },
            max_output_tokens: this.opts.maxOutputTokens ?? 300,
            store: false,
        }
        if (effort !== "omit") body.reasoning = { effort }
        const started = Date.now()
        const res = await this.client.responses.create(body, {
            signal,
            timeout: this.opts.timeoutMs ?? MODEL_TIMEOUT_MS,
            maxRetries: 0,
        })
        this.opts.onUsage?.({
            model: this.opts.model,
            latencyMs: Date.now() - started,
            inputTokens: res.usage?.input_tokens ?? null,
            outputTokens: res.usage?.output_tokens ?? null,
        })
        if (res.status && res.status !== "completed") {
            throw new ModelOutputError("INVALID_OUTPUT", `response ${res.status}${res.incomplete_details?.reason ? `: ${res.incomplete_details.reason}` : ""}`)
        }
        const refusal = findRefusal(res.output)
        if (refusal) throw new ModelOutputError("INVALID_OUTPUT", "model refused")
        const text = res.output_text ?? ""
        if (!text) throw new ModelOutputError("INVALID_OUTPUT", "empty output")
        return parseModelOutput(input, text)
    }
}

function findRefusal(output: unknown[] | undefined): boolean {
    if (!Array.isArray(output)) return false
    return output.some(item => {
        const content = (item as { content?: unknown }).content
        return Array.isArray(content) && content.some(c => (c as { type?: unknown }).type === "refusal")
    })
}

export class RulesModelAdapter implements AgentModel {
    readonly source = "RULES_FALLBACK" as const
    readonly label = "rules"
    constructor(private readonly policy: FallbackPolicy) {}
    async decide(input: AgentDecisionInput): Promise<AgentDecision> {
        return this.policy(input)
    }
}

// ---------------------------------------------------------------- configuration

export type AgentModelConfig =
    | { mode: "rules" }
    | { mode: "live"; model: string; apiKey: string; reasoningEffort: ReasoningEffortSetting }

export class AgentModelConfigError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "AgentModelConfigError"
    }
}

const EFFORTS = new Set<ReasoningEffortSetting>(["none", "minimal", "low", "medium", "high", "omit"])

// AGENT_MODE=live requires OPENAI_API_KEY and OPENAI_MODEL. AGENT_MODE=rules needs neither.
// OPENAI_REASONING_EFFORT defaults to none; set omit for models without a reasoning parameter.
export function agentModelConfigFromEnv(env: Record<string, string | undefined>): AgentModelConfig {
    const mode = (env.AGENT_MODE ?? "").trim() || "rules"
    if (mode === "rules") return { mode: "rules" }
    if (mode !== "live") throw new AgentModelConfigError("AGENT_MODE must be live or rules")
    const model = env.OPENAI_MODEL?.trim()
    const apiKey = env.OPENAI_API_KEY?.trim()
    if (!model) throw new AgentModelConfigError("AGENT_MODE=live requires OPENAI_MODEL")
    if (!apiKey) throw new AgentModelConfigError("AGENT_MODE=live requires OPENAI_API_KEY")
    const effort = (env.OPENAI_REASONING_EFFORT?.trim() || "none") as ReasoningEffortSetting
    if (!EFFORTS.has(effort)) throw new AgentModelConfigError("OPENAI_REASONING_EFFORT must be none, minimal, low, medium, high or omit")
    return { mode: "live", model, apiKey, reasoningEffort: effort }
}

// Redacted readiness for /api/health and the snapshot. Rules mode is reported as DEGRADED so
// it is never mistaken for a ready live model.
export function agentModelHealth(env: Record<string, string | undefined>): DependencyHealth {
    try {
        const cfg = agentModelConfigFromEnv(env)
        if (cfg.mode === "rules") return { status: "DEGRADED", detail: "AGENT_MODE=rules: decisions come from the deterministic policy, no model calls" }
        return { status: "READY", detail: `live model ${cfg.model}` }
    } catch (err) {
        return { status: "UNAVAILABLE", detail: err instanceof Error ? err.message : "model configuration invalid" }
    }
}

export function createAgentModel(
    env: Record<string, string | undefined>,
    policy: FallbackPolicy,
    extra: Pick<OpenAIAdapterOptions, "onUsage" | "client"> = {},
): AgentModel {
    const cfg = agentModelConfigFromEnv(env)
    if (cfg.mode === "rules") return new RulesModelAdapter(policy)
    return new OpenAIModelAdapter({ model: cfg.model, apiKey: cfg.apiKey, reasoningEffort: cfg.reasoningEffort, ...extra })
}
