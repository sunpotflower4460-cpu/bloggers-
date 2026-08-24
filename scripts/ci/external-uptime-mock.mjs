import http from "node:http";

const port = Number(process.env.MOCK_PORT || 47891);
const state = {
  healthy: false,
  nextIssue: 1,
  issues: [],
  comments: [],
  notifications: [],
};

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(response, state.healthy ? 200 : 503, { status: state.healthy ? "ok" : "degraded" });
  }

  if (request.method === "POST" && url.pathname === "/control/healthy") {
    state.healthy = true;
    return json(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/state") {
    return json(response, 200, state);
  }

  if (request.method === "POST" && url.pathname === "/webhook") {
    state.notifications.push(await body(request));
    return json(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/repos/test/repo/issues") {
    return json(response, 200, state.issues.filter((issue) => issue.state === "open"));
  }

  if (request.method === "POST" && url.pathname === "/repos/test/repo/issues") {
    const input = await body(request);
    const issue = {
      number: state.nextIssue++,
      title: input.title,
      body: input.body,
      state: "open",
      html_url: `http://example.invalid/issues/${state.nextIssue - 1}`,
    };
    state.issues.push(issue);
    return json(response, 201, issue);
  }

  const commentMatch = url.pathname.match(/^\/repos\/test\/repo\/issues\/(\d+)\/comments$/);
  if (request.method === "POST" && commentMatch) {
    const input = await body(request);
    state.comments.push({ issue: Number(commentMatch[1]), body: input.body });
    return json(response, 201, { id: state.comments.length, body: input.body });
  }

  const issueMatch = url.pathname.match(/^\/repos\/test\/repo\/issues\/(\d+)$/);
  if (request.method === "PATCH" && issueMatch) {
    const input = await body(request);
    const issue = state.issues.find((item) => item.number === Number(issueMatch[1]));
    if (!issue) return json(response, 404, { message: "not found" });
    Object.assign(issue, input);
    return json(response, 200, issue);
  }

  return json(response, 404, { message: "not found", method: request.method, path: url.pathname });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`external uptime mock listening on ${port}`);
});

function close() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
