import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Publication } from "./types";
import type { PublishResult } from "./platforms/base";

type DB = InstanceType<typeof Database>;
const path = resolve(process.env.DATABASE_PATH || "./data/blog-garden.sqlite");
mkdirSync(dirname(path), { recursive: true });
const globalDb = globalThis as typeof globalThis & { __blogGardenPublicationStoreDb?: DB };
const db = globalDb.__blogGardenPublicationStoreDb ?? new Database(path);
if (process.env.NODE_ENV !== "production") globalDb.__blogGardenPublicationStoreDb = db;
db.pragma("journal_mode = WAL");

function mapPublication(row: any): Publication {
  return {
    id: Number(row.id),
    blogId: row.blog_id,
    platformPostId: row.platform_post_id,
    title: row.title,
    url: row.url,
    status: row.status,
    sourceUrls: JSON.parse(row.source_urls_json || "[]"),
    publishedAt: row.published_at || null,
    createdAt: row.created_at,
  };
}

export function getPublicationById(publicationId: number): Publication | null {
  if (!Number.isInteger(publicationId) || publicationId <= 0) return null;
  const row = db.prepare("SELECT * FROM publications WHERE id=?").get(publicationId);
  return row ? mapPublication(row) : null;
}

export function reconcilePublicationPublished(publicationId: number, result: PublishResult): Publication {
  if (!Number.isInteger(publicationId) || publicationId <= 0) throw new Error("publicationId must be a positive integer");
  if (result.status !== "published") throw new Error("publish result must be published before local reconciliation");
  const info = db.prepare(`UPDATE publications
    SET status='published',url=?,published_at=COALESCE(?,published_at)
    WHERE id=?`).run(result.url, result.publishedAt, publicationId);
  if (info.changes !== 1) throw new Error("publication was not found during publish reconciliation");
  const publication = getPublicationById(publicationId);
  if (!publication) throw new Error("publication disappeared after publish reconciliation");
  return publication;
}
