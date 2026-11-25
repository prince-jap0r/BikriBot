# BikriBot — Facebook Page Sales AI Agent

মাল্টি-টেন্যান্ট Facebook Messenger সেলস এজেন্ট। Next.js App Router, TypeScript, Vercel AI SDK, Supabase অথবা PostgreSQL ব্যবহার করে।

## ফাইল স্ট্রাকচার

```text
prompts/            core, flow, psych, db ও memory prompt modules
supabase/schema.sql টেবিল, RLS, quote/order RPC ও demo seed
src/config/         Facebook, AI ও application configuration
src/lib/ai/         provider, prompt, tools, agent, consent ও memory flow
src/lib/facebook/   Graph API, signature, message splitting ও webhook safety
src/lib/repo/       Supabase এবং PostgreSQL repository implementations
src/app/api/        Facebook webhook, chat, admin ও health endpoints
tests/              automated regression tests
```

## সেটআপ

1. **ডাটাবেস তৈরি করুন।** Supabase-এ নতুন project খুলে SQL Editor-এ `supabase/schema.sql` সম্পূর্ণ চালান। এতে RLS, tenant-scoped tables, quote-consent RPC, activity/PII triggers এবং demo seed তৈরি হবে। Supabase-এ server-only `SUPABASE_SERVICE_ROLE_KEY` ব্যবহার করুন; কখনো `NEXT_PUBLIC_` prefix দেবেন না।
2. **Environment তৈরি করুন।** `.env.example` কপি করে `.env.local` বানান এবং আপনার provider/database/Facebook/admin-এর মান দিন। `.env.local` source control বা ZIP-এ দেবেন না। Production-এ `DB_DRIVER` স্পষ্টভাবে `supabase` বা `postgres` দিন এবং প্রয়োজনীয় connection settings পূরণ করুন।
3. **Meta webhook কনফিগার করুন।** Callback URL হবে `https://<your-domain>/api/webhook/facebook`; verify token ও app secret দিন, Messenger-এর `messages` এবং `messaging_postbacks` ইভেন্ট subscribe করুন। Production-এ `FB_VERIFY_SIGNATURE=true`, `FB_APP_SECRET` ও `FB_VERIFY_TOKEN` আবশ্যক।
4. **Page ও catalog সেট করুন।** অ্যাডমিন UI-এর Setup ট্যাবে Page ID এবং প্রয়োজনীয় Page Access Token দিন; Product ট্যাবে পণ্য যোগ করুন। ডেলিভারি জোন `delivery_zones`-এ যোগ করুন। একটি empty-keyword zone কেবলমাত্র একটিই default হতে পারে।
5. **পরীক্ষা করে deploy করুন।** `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`, এবং `npm run build` চালিয়ে তারপর deploy করুন। Production-এ schema request-এর সময় auto-migrate হয় না—প্রতিটি schema update deployment-এর আগে migration হিসেবে প্রয়োগ করুন।

## অর্ডার কনফার্মেশন ও নিরাপত্তা

- AI tool কেবল database-verified, স্বল্পমেয়াদি quote তৈরি করে; সরাসরি অর্ডার জমা দিতে পারে না। কাস্টমারকে deterministic summary দেখানোর পর আলাদা মেসেজে একক, স্পষ্ট affirmative consent প্রয়োজন।
- Confirmation RPC quote expiry, page/customer ownership, পণ্যের বর্তমান দাম/স্টক এবং delivery-zone configuration পুনরায় যাচাই করে; quote row lock করে একবারই অর্ডার ও stock update করে। একই quote পুনরায় submit হলে আগের order reference-ই ফেরত আসে।
- অজানা বা ambiguous delivery zone-এ quote তৈরি হয় না। ফোন/ঠিকানা সাধারণ prompt memory থেকে বাদ; persisted memory এবং পুরোনো quote transcript model context-এ ব্যবহারের আগে sanitize হয়। Quote terminal state-এ গেলে quote table-এর PII scrub হয়।
- Facebook webhook raw-body HMAC signature যাচাই, bounded body/event count, malformed payload rejection এবং per-customer sequential processing ব্যবহার করে।
- `/api/admin/*` ও `/api/chat`-এ `x-admin-secret` আবশ্যক। Page access token write-only; admin overview-তে token value ফেরত আসে না।
- `/api/health`-এ `live` process liveness এবং `ready` service readiness বোঝায়। Production readiness-এর জন্য database, সক্রিয় AI provider credential, এবং secured webhook configuration প্রয়োজন।
- Supplied specification/archive-এ প্রকাশিত কোনো credential থাকলে সেটিকে compromised ধরে তার মালিককে production-এর আগে revoke/rotate করতে হবে। Credential এই source release-এ অন্তর্ভুক্ত করা যাবে না।

## AI provider / model

`AI_PROVIDER` দিয়ে `openrouter`, `openai`, `gemini`, `anthropic` অথবা `custom` provider নির্বাচন করা যায়। Provider অনুযায়ী API key ও compatible model name দিন। `AI_DEFAULT_MODEL` এবং `AI_FALLBACK_MODEL` provider-এর model catalog-এর সঙ্গে মিলিয়ে সেট করুন।

## লোকাল ডেভেলপমেন্ট

Supabase configuration না থাকলে development-এ `DATABASE_URL`-এর local PostgreSQL fallback ব্যবহৃত হয় এবং প্রথম repository access-এ idempotent schema প্রয়োগ হয়। Production-এ schema request থেকে auto-apply হয় না।

```bash
cp .env.example .env.local
# .env.local সম্পাদনা করুন
npm ci
npm test
npm run typecheck
npm run lint
npm run dev
```
