import type { BlogPlatform } from "./types";

export interface WordPressCredentials {
  username: string;
  applicationPassword: string;
}

export interface GhostCredentials {
  adminApiKey: string;
}

export interface BloggerCredentials {
  blogId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type PlatformCredentials = WordPressCredentials | GhostCredentials | BloggerCredentials;

function value(form: FormData, key: string): string {
  return String(form.get(key) || "").trim();
}

export function hasCredentialInput(form: FormData, platform: BlogPlatform): boolean {
  if (platform === "wordpress") return Boolean(value(form, "wpUsername") || value(form, "wpApplicationPassword"));
  if (platform === "ghost") return Boolean(value(form, "ghostAdminApiKey"));
  return Boolean(value(form, "bloggerBlogId") || value(form, "bloggerClientId") || value(form, "bloggerClientSecret") || value(form, "bloggerRefreshToken"));
}

export function credentialsFromForm(form: FormData, platform: BlogPlatform): PlatformCredentials {
  if (platform === "wordpress") {
    const credentials: WordPressCredentials = {
      username: value(form, "wpUsername"),
      applicationPassword: value(form, "wpApplicationPassword").replace(/\s+/g, ""),
    };
    if (!credentials.username || !credentials.applicationPassword) {
      throw new Error("WordPressのユーザー名とApplication Passwordを入力してください");
    }
    return credentials;
  }

  if (platform === "ghost") {
    const credentials: GhostCredentials = { adminApiKey: value(form, "ghostAdminApiKey") };
    if (!/^[^:]+:[0-9a-fA-F]+$/.test(credentials.adminApiKey)) {
      throw new Error("Ghost Admin API Keyを id:secret の形式で入力してください");
    }
    return credentials;
  }

  const credentials: BloggerCredentials = {
    blogId: value(form, "bloggerBlogId"),
    clientId: value(form, "bloggerClientId"),
    clientSecret: value(form, "bloggerClientSecret"),
    refreshToken: value(form, "bloggerRefreshToken"),
  };
  if (!credentials.blogId || !credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
    throw new Error("BloggerのBlog ID、Client ID、Client Secret、Refresh Tokenをすべて入力してください");
  }
  return credentials;
}
