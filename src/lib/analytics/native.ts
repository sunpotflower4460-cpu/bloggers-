import type { Blog } from "../types";
import { decryptJson } from "../crypto";
import { recentPublications, upsertReaction } from "../db";
import { platformAdapter } from "../platforms";

export async function collectNativeReactions(blog: Blog): Promise<number> {
  const adapter = platformAdapter(blog.platform);
  if (!adapter.collectReactions) return 0;
  const credentials = decryptJson<unknown>(blog.credentialsCipher);
  const publications = recentPublications(blog.id, 20).filter((publication) => publication.status === "published");
  const date = new Date().toISOString().slice(0, 10);
  let matched = 0;

  for (const publication of publications) {
    try {
      const reaction = await adapter.collectReactions(blog, credentials, publication);
      upsertReaction(publication.id, date, Math.max(0, reaction.comments));
      matched += 1;
    } catch {
      // A single deleted/private post should not prevent the rest of the blog from being measured.
    }
  }
  return matched;
}
