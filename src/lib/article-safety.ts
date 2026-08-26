import type { GeneratedArticle } from "./types";

const ALLOWED_TAGS = new Set([
  "p", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em", "b", "i",
  "blockquote", "pre", "code", "hr", "br", "a",
]);
const VOID_TAGS = new Set(["hr", "br"]);
const DROP_WITH_CONTENT = [
  "script", "style", "iframe", "object", "embed", "form", "button", "textarea",
  "select", "option", "template", "svg", "math", "noscript",
];

function plainText(value: unknown): string {
  return String(value ?? "")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeUrlEntities(value: string): string {
  return value
    .replace(/&#(\d+);?/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&amp;/gi, "&");
}

function safeHref(value: string): string | null {
  const decoded = decodeUrlEntities(value).trim();
  const compact = decoded.replace(/[\u0000-\u0020\u007f]+/g, "");
  if (compact.startsWith("#")) return compact.slice(0, 240);
  try {
    const url = new URL(compact);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    return url.toString().slice(0, 2000);
  } catch {
    return null;
  }
}

function hrefFromAttributes(attributes: string): string | null {
  const match = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  return safeHref(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

export function sanitizeArticleHtml(value: unknown): string {
  let html = String(value ?? "");
  if (html.length > 150_000) throw new Error("Generated article HTML is too large");

  html = html
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<!doctype[^>]*>/gi, "");

  for (const tag of DROP_WITH_CONTENT) {
    html = html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
  }
  html = html.replace(/<(?:input|meta|link|base)\b[^>]*\/?\s*>/gi, "");

  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9:-]*)(\s[^>]*)?>/g, (match, rawTag, rawAttributes = "") => {
    const tag = String(rawTag).toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    const closing = /^<\//.test(match);
    if (closing) return VOID_TAGS.has(tag) ? "" : `</${tag}>`;
    if (VOID_TAGS.has(tag)) return `<${tag}>`;
    if (tag !== "a") return `<${tag}>`;
    const href = hrefFromAttributes(String(rawAttributes));
    return href ? `<a href="${href.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" rel="noopener noreferrer">` : "<a>";
  });

  const text = plainText(html);
  if (text.length < 80) throw new Error("Generated article is too short after HTML safety filtering");
  if (/<\s*(script|iframe|object|embed|form|svg|math)\b/i.test(html)) throw new Error("Unsafe HTML survived filtering");
  if (/\bon[a-z]+\s*=/i.test(html) || /\bjavascript\s*:/i.test(html)) throw new Error("Unsafe HTML attribute survived filtering");
  return html.trim();
}

export function secureGeneratedArticle(value: GeneratedArticle): GeneratedArticle {
  const title = plainText(value?.title).slice(0, 180);
  const excerpt = plainText(value?.excerpt).slice(0, 600);
  if (!title) throw new Error("Generated article title is empty");
  const tags = Array.isArray(value?.tags)
    ? [...new Set(value.tags.map((tag) => plainText(tag).slice(0, 60)).filter(Boolean))].slice(0, 12)
    : [];
  const sourceUrls = Array.isArray(value?.sourceUrls)
    ? value.sourceUrls.filter((url): url is string => typeof url === "string").slice(0, 20)
    : [];
  return {
    title,
    excerpt,
    html: sanitizeArticleHtml(value?.html),
    tags,
    sourceUrls,
  };
}
