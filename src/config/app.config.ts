/** General application configuration (non-Facebook, non-AI). */

export type DbDriver = "supabase" | "postgres";

export function resolveDbDriver(): DbDriver {
  const forced = (process.env.DB_DRIVER || "").toLowerCase();
  if (forced && forced !== "supabase" && forced !== "postgres") {
    throw new Error("DB_DRIVER must be either 'supabase' or 'postgres'");
  }
  const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hasPostgres = !!process.env.DATABASE_URL;
  if (forced === "supabase" && !hasSupabase) {
    throw new Error("DB_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  if (forced === "postgres" && !hasPostgres) {
    throw new Error("DB_DRIVER=postgres requires DATABASE_URL");
  }
  if (process.env.NODE_ENV === "production" && !forced && !hasSupabase && !hasPostgres) {
    throw new Error("Production requires explicit Supabase credentials or DATABASE_URL");
  }
  if (forced === "supabase" || forced === "postgres") return forced;
  // Supabase is the primary store. Local Postgres is only a fallback for sandboxes/dev.
  if (hasSupabase) return "supabase";
  if (process.env.NODE_ENV === "production" && hasPostgres) return "postgres";
  return "postgres";
}

export const appConfig = {
  /** Secret for the admin dashboard + test chat API (sent as `x-admin-secret`). */
  get adminSecret(): string {
    return process.env.ADMIN_SECRET || "";
  },
  /** Used when a page has no custom shop name. */
  defaultShopName: process.env.DEFAULT_SHOP_NAME || "আমাদের শপ",
  currency: process.env.CURRENCY_SYMBOL || "৳",
  /** Webhook dedup / safety. */
  maxIncomingChars: 1500,
};
