export type FallbackContentPolicy = "review" | "allow-auto";
export type ContentAiRoute = "primary" | "fallback";
export type ContentPublishMode = "auto" | "review";

export function fallbackContentPolicy(): FallbackContentPolicy {
  const raw = process.env.AI_FALLBACK_CONTENT_POLICY?.trim().toLowerCase() || "review";
  if (raw === "review" || raw === "allow-auto") return raw;
  throw new Error("AI_FALLBACK_CONTENT_POLICY must be 'review' or 'allow-auto'");
}

export function publishModeForContent(
  originalMode: ContentPublishMode,
  route: ContentAiRoute,
  policy = fallbackContentPolicy(),
): ContentPublishMode {
  if (originalMode === "review") return "review";
  if (route === "fallback" && policy === "review") return "review";
  return "auto";
}

export function mayMutatePublishedContent(
  route: ContentAiRoute,
  policy = fallbackContentPolicy(),
): boolean {
  return !(route === "fallback" && policy === "review");
}
