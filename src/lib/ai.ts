import { recordAiUsage, reserveAiCall } from "./ai-budget";
import { isRetryableAiStatus, recordAiProviderAttempt, resolveAiRoutePlan, type AiRoute } from "./ai-routing";

export interface AiJsonRouteMeta {
  route: "primary" | "fallback";
  label: string;
  model: string;
  bypassedPrimary: boolean;
}

export interface AiJsonResult<T> {
  value: T;
  meta: AiJsonRouteMeta;
}

function extractText(payload: any): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const chunks: string[] = [];
  for (const item of payload.output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

function parseJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error("AI returned invalid JSON");
  }
}

function safeProviderError(value: unknown): string {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|password|secret|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, (candidate) => {
      try {
        const parsed = new URL(candidate);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "[url]";
      }
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

class AiRouteFailure extends Error {
  constructor(
    message: string,
    readonly route: AiRoute,
    readonly retryable: boolean,
    readonly statusCode: number | null,
  ) {
    super(message);
    this.name = "AiRouteFailure";
  }
}

function requestBody(route: AiRoute, system: string, user: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: route.model,
    input: [
      { role: "system", content: system },
      { role: "user", content: `${user}\n\nReturn one valid JSON object only. No markdown fences.` },
    ],
  };
  const maxOutput = Number.parseInt(process.env.AI_MAX_OUTPUT_TOKENS || "", 10);
  if (Number.isFinite(maxOutput) && maxOutput > 0) body.max_output_tokens = Math.min(maxOutput, 100_000);
  return body;
}

async function callRoute(route: AiRoute, system: string, user: string): Promise<any> {
  // Every actual outbound request consumes one slot from the shared daily budget.
  // A failover or circuit-bypassed request therefore cannot reset the ceiling.
  reserveAiCall(`${route.label}:${route.model}`);

  let response: Response;
  try {
    response = await fetch(`${route.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${route.apiKey}`,
      },
      body: JSON.stringify(requestBody(route, system, user)),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    const detail = safeProviderError(error instanceof Error ? error.message : error) || "network request failed";
    recordAiProviderAttempt({
      route: route.kind,
      label: route.label,
      model: route.model,
      outcome: "retryable_error",
      detail,
    });
    throw new AiRouteFailure(`AI ${route.kind} route network failure: ${detail}`, route, true, null);
  }

  if (!response.ok) {
    const detail = safeProviderError(await response.text().catch(() => ""));
    const retryable = isRetryableAiStatus(response.status);
    recordAiProviderAttempt({
      route: route.kind,
      label: route.label,
      model: route.model,
      outcome: retryable ? "retryable_error" : "fatal_error",
      statusCode: response.status,
      detail,
    });
    throw new AiRouteFailure(
      `AI ${route.kind} route failed ${response.status}${detail ? `: ${detail}` : ""}`,
      route,
      retryable,
      response.status,
    );
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch (error) {
    const detail = safeProviderError(error instanceof Error ? error.message : error) || "invalid JSON response";
    recordAiProviderAttempt({
      route: route.kind,
      label: route.label,
      model: route.model,
      outcome: "fatal_error",
      statusCode: response.status,
      detail,
    });
    throw new AiRouteFailure(`AI ${route.kind} route returned invalid protocol JSON: ${detail}`, route, false, response.status);
  }

  recordAiUsage(payload?.usage, `${route.label}:${route.model}`);
  recordAiProviderAttempt({
    route: route.kind,
    label: route.label,
    model: route.model,
    outcome: "ok",
    statusCode: response.status,
  });
  return payload;
}

export async function aiJsonWithMeta<T>(system: string, user: string): Promise<AiJsonResult<T>> {
  const plan = resolveAiRoutePlan();
  let payload: any;
  let usedRoute: AiRoute;

  if (plan.bypassedPrimary) {
    if (!plan.fallback) throw new Error("AI primary circuit is open but no fallback route is available");
    try {
      usedRoute = plan.fallback;
      payload = await callRoute(plan.fallback, system, user);
    } catch (error) {
      throw new Error(`AI primary circuit is open and fallback failed: ${safeProviderError(error instanceof Error ? error.message : error)}`);
    }
  } else {
    if (!plan.primary) throw new Error("AI primary route is unavailable");
    try {
      usedRoute = plan.primary;
      payload = await callRoute(plan.primary, system, user);
    } catch (error) {
      if (!(error instanceof AiRouteFailure) || !error.retryable || !plan.fallback) throw error;
      try {
        usedRoute = plan.fallback;
        payload = await callRoute(plan.fallback, system, user);
      } catch (fallbackError) {
        const primaryDetail = safeProviderError(error.message);
        const fallbackDetail = safeProviderError(fallbackError instanceof Error ? fallbackError.message : fallbackError);
        throw new Error(`AI primary route unavailable and bounded fallback failed. primary=${primaryDetail}; fallback=${fallbackDetail}`);
      }
    }
  }

  // Output-shape errors are deliberately not retried on another provider. They are
  // editorial/model-quality failures, not transport availability failures, and a
  // second generation would spend extra budget while hiding the real defect.
  return {
    value: parseJson<T>(extractText(payload)),
    meta: {
      route: usedRoute.kind,
      label: usedRoute.label,
      model: usedRoute.model,
      bypassedPrimary: plan.bypassedPrimary,
    },
  };
}

export async function aiJson<T>(system: string, user: string): Promise<T> {
  return (await aiJsonWithMeta<T>(system, user)).value;
}
