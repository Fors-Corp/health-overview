import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let cached: Db | null = null;

/**
 * Built on first use rather than at module scope.
 *
 * Next evaluates route modules while collecting page data during `next build`, so
 * throwing here at import time made the production build depend on a database URL
 * that is only needed to serve a request. A missing variable now surfaces as a clear
 * runtime error on the request that needs it, instead of breaking the build.
 */
function getDb(): Db {
  if (cached) return cached;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  // Serverless invocations are short-lived; a single connection per instance avoids
  // exhausting the Postgres connection limit across concurrent lambdas.
  cached = drizzle(postgres(connectionString, { max: 1 }), { schema });
  return cached;
}

export const db = new Proxy({} as Db, {
  get: (_target, prop, receiver) => Reflect.get(getDb(), prop, receiver),
});

export * from "./schema";

/**
 * Whether a database is configured at all.
 *
 * Server Components call this BEFORE touching `db`, so a deployment with no
 * DATABASE_URL renders an explanatory setup page instead of throwing. Without it
 * the miss surfaces as Next's generic "A server error occurred" screen: in
 * production Next strips the real message and ships only an opaque digest, so the
 * one person who can fix the problem is told nothing about what is wrong.
 */
export function isDatabaseConfigured(): boolean {
  const url = process.env.DATABASE_URL;
  return typeof url === "string" && url.trim().length > 0;
}
