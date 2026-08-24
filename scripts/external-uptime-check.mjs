const HEALTH_URL = process.env.BLOG_GARDEN_HEALTH_URL?.trim();
const REPOSITORY = process.env.GITHUB_REPOSITORY?.trim();
const TOKEN = process.env.GITHUB_TOKEN?.trim();
const API_URL = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const WEBHOOK_URL = process.env.BLOG_GARDEN_UPTIME_WEBHOOK_URL?.trim();
const WEBHOOK_KIND = (process.env.BLOG_GARDEN_UPTIME_WEBHOOK_KIND || "auto").toLowerCase();
const REQUIRE_HTTPS = process.env.EXTERNAL_MONITOR_REQUIRE_HTTPS !== "false";
const INCIDENT_TITLE = "[Blog Garden] External uptime incident";

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sanitizedEndpoint(raw) {
  const url = new URL(raw);
  if (url.username || url.password) throw new Error("BLOG_GARDEN_HEALTH_URL must not contain embedded credentials");
  if (REQUIRE_HTTPS && url.protocol !== "https:") throw new Error("BLOG_GARDEN_HEALTH_URL must use HTTPS");
  if (!url.pathname.endsWith("/api/health")) throw new Error("BLOG_GARDEN_HEALTH_URL must point to /api/health");
  return `${url.origin}${url.pathname}`;
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/(token|password|secret|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, (value) => {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "[url]";
      }
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function github(path, init = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${safeError(text)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function findOpenIncident() {
  const issues = await github(`/repos/${REPOSITORY}/issues?state=open&per_page=100`);
  return Array.isArray(issues)
    ? issues.find((issue) => !issue.pull_request && issue.title === INCIDENT_TITLE) || null
    : null;
}

async function probe(raw) {
  try {
    const response = await fetch(raw, {
      headers: { accept: "application/json", "user-agent": "blog-garden-external-monitor" },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => null);
    if (response.status === 200 && body?.status === "ok") {
      return { healthy: true, detail: "HTTP 200 / status=ok" };
    }
    return { healthy: false, detail: `HTTP ${response.status} / status=${body?.status || "invalid"}` };
  } catch (error) {
    return { healthy: false, detail: safeError(error) || "request failed" };
  }
}

function webhookType(url) {
  if (WEBHOOK_KIND === "slack" || WEBHOOK_KIND === "discord" || WEBHOOK_KIND === "generic") return WEBHOOK_KIND;
  if (url.hostname === "hooks.slack.com") return "slack";
  if (url.hostname === "discord.com" || url.hostname === "discordapp.com") return "discord";
  return "generic";
}

async function notify(kind, endpoint, detail, issueUrl) {
  if (!WEBHOOK_URL) return false;
  const url = new URL(WEBHOOK_URL);
  if (REQUIRE_HTTPS && url.protocol !== "https:") throw new Error("BLOG_GARDEN_UPTIME_WEBHOOK_URL must use HTTPS");
  const marker = kind === "outage" ? "CRITICAL" : "RECOVERY";
  const text = `[Blog Garden][${marker}][external] ${endpoint}\n${detail}${issueUrl ? `\n${issueUrl}` : ""}`;
  const type = webhookType(url);
  const body = type === "slack"
    ? { text }
    : type === "discord"
      ? { content: text.slice(0, 1900) }
      : { text, severity: kind === "outage" ? "critical" : "recovery", code: "external-uptime", scope: endpoint, detail, issueUrl: issueUrl || null, at: new Date().toISOString() };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`External uptime webhook failed with HTTP ${response.status}`);
  return true;
}

async function main() {
  required("BLOG_GARDEN_HEALTH_URL", HEALTH_URL);
  required("GITHUB_REPOSITORY", REPOSITORY);
  required("GITHUB_TOKEN", TOKEN);
  const endpoint = sanitizedEndpoint(HEALTH_URL);
  const probeResult = await probe(HEALTH_URL);
  const incident = await findOpenIncident();
  const now = new Date().toISOString();

  if (!probeResult.healthy && !incident) {
    const created = await github(`/repos/${REPOSITORY}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: INCIDENT_TITLE,
        body: [
          "Blog Gardenの外部監視が `/api/health` の異常を検知しました。",
          "",
          `- endpoint: \`${endpoint}\``,
          `- detected_at: \`${now}\``,
          `- result: \`${safeError(probeResult.detail)}\``,
          "",
          "VPS / DNS / TLS / Caddy / web serviceを確認してください。復旧を外部監視が確認すると、このIssueは自動でクローズされます。",
        ].join("\n"),
      }),
    });
    await notify("outage", endpoint, safeError(probeResult.detail), created?.html_url || null);
    console.error(`External outage opened: ${created?.html_url || INCIDENT_TITLE}`);
    process.exitCode = 1;
    return;
  }

  if (!probeResult.healthy && incident) {
    console.error(`External outage still open: ${incident.html_url || `#${incident.number}`}`);
    process.exitCode = 1;
    return;
  }

  if (probeResult.healthy && incident) {
    await github(`/repos/${REPOSITORY}/issues/${incident.number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: `外部監視が復旧を確認しました。\n\n- recovered_at: \`${now}\`\n- result: \`${probeResult.detail}\`` }),
    });
    await github(`/repos/${REPOSITORY}/issues/${incident.number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    });
    await notify("recovery", endpoint, probeResult.detail, incident.html_url || null);
    console.log(`External outage recovered: ${incident.html_url || `#${incident.number}`}`);
    return;
  }

  console.log(`External uptime healthy: ${endpoint}`);
}

main().catch((error) => {
  console.error(`External uptime monitor failed: ${safeError(error)}`);
  process.exitCode = 2;
});
