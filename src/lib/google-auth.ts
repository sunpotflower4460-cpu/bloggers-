import { createSign } from "node:crypto";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function b64(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export async function googleServiceToken(scopes: string[]): Promise<string | null> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const sa = JSON.parse(raw) as ServiceAccount;
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is incomplete");
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64(JSON.stringify({
    iss: sa.client_email,
    scope: [...new Set(scopes)].join(" "),
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(sa.private_key).toString("base64url")}`;
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error(`Google OAuth failed ${response.status}: ${await response.text()}`);
  const payloadJson = await response.json();
  if (!payloadJson.access_token) throw new Error("Google OAuth response did not contain an access token");
  return String(payloadJson.access_token);
}
