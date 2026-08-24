import { recordAiUsage, reserveAiCall } from "./ai-budget";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
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

function safeProviderError(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|password|secret|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export async function aiJson<T>(system: string, user: string): Promise<T> {
  const base = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = env("AI_MODEL");
  const apiKey = env("AI_API_KEY");
  reserveAiCall(model);

  const requestBody: Record<string, unknown> = {
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: `${user}\n\nReturn one valid JSON object only. No markdown fences.` },
    ],
  };
  const maxOutput = Number.parseInt(process.env.AI_MAX_OUTPUT_TOKENS || "", 10);
  if (Number.isFinite(maxOutput) && maxOutput > 0) requestBody.max_output_tokens = Math.min(maxOutput, 100_000);

  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const detail = safeProviderError(await response.text().catch(() => ""));
    throw new Error(`AI request failed ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const payload = await response.json();
  recordAiUsage(payload?.usage, model);
  return parseJson<T>(extractText(payload));
}
