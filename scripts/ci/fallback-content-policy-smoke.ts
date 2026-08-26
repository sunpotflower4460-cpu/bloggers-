import {
  fallbackContentPolicy,
  mayMutatePublishedContent,
  publishModeForContent,
} from "../../src/lib/ai-content-policy";

delete process.env.AI_FALLBACK_CONTENT_POLICY;
if (fallbackContentPolicy() !== "review") throw new Error("fallback content policy must default to review");
if (publishModeForContent("auto", "fallback") !== "review") {
  throw new Error("fallback-generated auto content was not downgraded to review");
}
if (publishModeForContent("auto", "primary") !== "auto") {
  throw new Error("primary-generated auto content was unexpectedly downgraded");
}
if (publishModeForContent("review", "fallback") !== "review") {
  throw new Error("review-mode blog must remain review mode");
}
if (mayMutatePublishedContent("fallback")) {
  throw new Error("fallback-generated proposal must not mutate published content under review policy");
}
if (!mayMutatePublishedContent("primary")) {
  throw new Error("primary-generated proposal should remain eligible for published-content mutation");
}

process.env.AI_FALLBACK_CONTENT_POLICY = "allow-auto";
if (fallbackContentPolicy() !== "allow-auto") throw new Error("allow-auto policy was not accepted");
if (publishModeForContent("auto", "fallback") !== "auto") {
  throw new Error("explicit allow-auto did not preserve auto publish mode");
}
if (!mayMutatePublishedContent("fallback")) {
  throw new Error("explicit allow-auto did not permit fallback published-content mutation");
}

process.env.AI_FALLBACK_CONTENT_POLICY = "unsafe-magic";
let invalidRejected = false;
try {
  fallbackContentPolicy();
} catch (error) {
  invalidRejected = String(error).includes("AI_FALLBACK_CONTENT_POLICY");
}
if (!invalidRejected) throw new Error("invalid fallback content policy was not rejected");

console.log(JSON.stringify({ ok: true, defaultPolicy: "review", optInPolicy: "allow-auto" }));
