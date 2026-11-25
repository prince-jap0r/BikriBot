import { resolveDbDriver } from "@/config/app.config";
import { createSupabaseRepo } from "./supabase";
import type { Repo } from "./types";

export * from "./types";

const g = globalThis as typeof globalThis & { __bikribotRepo?: Repo };

/** Returns the singleton repository (Supabase primary, local Postgres fallback). */
export async function getRepo(): Promise<Repo> {
  if (g.__bikribotRepo) return g.__bikribotRepo;
  let repo: Repo;
  if (resolveDbDriver() === "supabase") {
    repo = createSupabaseRepo();
  } else {
    // Lazy import so Vercel/Supabase deployments never need DATABASE_URL.
    const { createPostgresRepo } = await import("./postgres");
    repo = createPostgresRepo();
  }
  g.__bikribotRepo = repo;
  return repo;
}
