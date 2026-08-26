export type FallbackContentPolicy = "review" | "allow-auto";

export function fallbackContentPolicy(): FallbackContentPolicy {
  const raw = process.env.AI_FALLBACK_CONTENT_POLICY?.trim().toLowerCase() || "review";
  if (raw === "review" || raw === "allow-auto") return raw;
  throw new Error("AI_FALLBACK_CONTENT_POLICY must be 'review' or 'allow-auto'");
}
