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

export async function aiJson<T>(system: string, user: string): Promise<T> {
  const base = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env("AI_API_KEY")}`,
    },
    body: JSON.stringify({
      model: env("AI_MODEL"),
      input: [
        { role: "system", content: system },
        { role: "user", content: `${user}\n\nReturn one valid JSON object only. No markdown fences.` },
      ],
    }),
  });
  if (!response.ok) throw new Error(`AI request failed ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  return parseJson<T>(extractText(payload));
}
