import type { Blog, Publication } from "../types";
import { decryptJson } from "../crypto";
import { recentPublications, upsertReaction } from "../db";
import { platformAdapter } from "../platforms";

async function collectBatch(blog: Blog, credentials: unknown, publications: Publication[], date: string): Promise<number> {
  const adapter = platformAdapter(blog.platform);
  const outcomes: number[] = await Promise.all(publications.map(async (publication): Promise<number> => {
    try {
      const reaction = await adapter.collectReactions!(blog, credentials, publication);
      upsertReaction(publication.id, date, Math.max(0, reaction.comments));
      return 1;
    } catch {
      // A single deleted/private post should not prevent the rest of the blog from being measured.
      return 0;
    }
  }));
  return outcomes.reduce((sum, value) => sum + value, 0);
}

export async function collectNativeReactions(blog: Blog): Promise<number> {
  const adapter = platformAdapter(blog.platform);
  if (!adapter.collectReactions) return 0;
  const credentials = decryptJson<unknown>(blog.credentialsCipher);
  const publications = recentPublications(blog.id, 20).filter((publication) => publication.status === "published");
  const date = new Date().toISOString().slice(0, 10);
  let matched = 0;

  // Keep concurrency intentionally small: enough to avoid serial latency without
  // hammering a self-hosted WordPress/Ghost/Blogger endpoint.
  for (let i = 0; i < publications.length; i += 4) {
    matched += await collectBatch(blog, credentials, publications.slice(i, i + 4), date);
  }
  return matched;
}
