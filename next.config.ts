import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Make sure the modular prompt files and SQL schema are bundled into the serverless functions.
  outputFileTracingIncludes: {
    "/api/**/*": ["./prompts/**/*", "./supabase/schema.sql"],
  },
};

export default nextConfig;
