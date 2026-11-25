import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("PostgreSQL schema installs and quote confirmation is atomic, replay-safe, and PII-scrubbing", async () => {
  const db = new PGlite();
  try {
    const schema = await readFile(path.join(process.cwd(), "supabase", "schema.sql"), "utf8");
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
    await db.exec(`create function bikribot_create_order(text, uuid, text, text, text, jsonb, integer, text)
      returns jsonb language sql as $$ select '{}'::jsonb $$`);
    await db.exec(schema);
    await db.exec(schema); // deployment schema is intentionally re-runnable

    const legacyRpc = await db.query<{ count: number }>(
      "select count(*)::int as count from pg_proc where proname = 'bikribot_create_order'",
    );
    assert.equal(legacyRpc.rows[0]!.count, 0);

    const rpcGrants = await db.query<{ service_can_confirm: boolean; service_can_redact: boolean; anon_can_confirm: boolean; authenticated_can_confirm: boolean }>(
      `select has_function_privilege('service_role', 'bikribot_confirm_order_quote(uuid,text,uuid)', 'execute') as service_can_confirm,
              has_function_privilege('service_role', 'bikribot_redact_order_details(text,uuid,text)', 'execute') as service_can_redact,
              has_function_privilege('anon', 'bikribot_confirm_order_quote(uuid,text,uuid)', 'execute') as anon_can_confirm,
              has_function_privilege('authenticated', 'bikribot_confirm_order_quote(uuid,text,uuid)', 'execute') as authenticated_can_confirm`,
    );
    assert.equal(rpcGrants.rows[0]!.service_can_confirm, true);
    assert.equal(rpcGrants.rows[0]!.service_can_redact, true);
    assert.equal(rpcGrants.rows[0]!.anon_can_confirm, false);
    assert.equal(rpcGrants.rows[0]!.authenticated_can_confirm, false);
    const rls = await db.query<{ count: number }>(
      `select count(*)::int as count from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any(array['pages','products','delivery_zones','customers','messages','customer_memories','orders','order_quotes'])
         and c.relrowsecurity`,
    );
    assert.equal(rls.rows[0]!.count, 8);

    const tableGrants = await db.query<{ count: number }>(
      `select count(*)::int as count from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('anon','authenticated')`,
    );
    assert.equal(tableGrants.rows[0]!.count, 0);
    await db.exec("create table public.default_privilege_probe (id integer); create sequence public.default_privilege_probe_seq;");
    const defaultTableGrants = await db.query<{ count: number }>(
      `select count(*)::int as count from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'default_privilege_probe' and grantee in ('anon','authenticated')`,
    );
    assert.equal(defaultTableGrants.rows[0]!.count, 0);
    const defaultSequenceGrants = await db.query<{ anon_can_use: boolean; authenticated_can_use: boolean }>(
      `select has_sequence_privilege('anon','public.default_privilege_probe_seq','USAGE') as anon_can_use,
              has_sequence_privilege('authenticated','public.default_privilege_probe_seq','USAGE') as authenticated_can_use`,
    );
    assert.equal(defaultSequenceGrants.rows[0]!.anon_can_use, false);
    assert.equal(defaultSequenceGrants.rows[0]!.authenticated_can_use, false);
    await db.exec("create function public.default_privilege_probe_function() returns integer language sql as $$ select 1 $$;");
    const defaultFunctionGrants = await db.query<{ count: number }>(
      `select count(*)::int as count from information_schema.role_routine_grants
       where specific_schema = 'public' and routine_name = 'default_privilege_probe_function'
         and grantee in ('anon','authenticated')`,
    );
    assert.equal(defaultFunctionGrants.rows[0]!.count, 0);

    const appFunctionAccess = await db.query<{ anon_can_execute: boolean; authenticated_can_execute: boolean }>(
      `select bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) as anon_can_execute,
              bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) as authenticated_can_execute
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('bikribot_preserve_page_access_token','bikribot_touch_customer_on_message',
         'bikribot_scrub_terminal_order_quote','bikribot_confirm_order_quote','bikribot_redact_order_details')`,
    );
    assert.equal(appFunctionAccess.rows[0]!.anon_can_execute, false);
    assert.equal(appFunctionAccess.rows[0]!.authenticated_can_execute, false);

    const hardenedFunctions = await db.query<{ count: number }>(
      `select count(*)::int as count from pg_proc
       where proname in ('bikribot_preserve_page_access_token','bikribot_touch_customer_on_message',
         'bikribot_scrub_terminal_order_quote','bikribot_confirm_order_quote','bikribot_redact_order_details')
         and coalesce(array_to_string(proconfig, ';'), '') like '%search_path=%'`,
    );
    assert.equal(hardenedFunctions.rows[0]!.count, 5);

    // An omitted write-only token must not erase an existing page token on upsert.
    await db.exec("update pages set page_access_token = 'test-only-token' where page_id = 'demo'");
    await db.exec("update pages set shop_info = 'updated', page_access_token = null where page_id = 'demo'");
    const page = await db.query<{ page_access_token: string }>("select page_access_token from pages where page_id = 'demo'");
    assert.equal(page.rows[0]?.page_access_token, "test-only-token");

    const customerResult = await db.query<{ id: string }>(
      "insert into customers (page_id, psid, name) values ('demo', 'test-customer-1', 'পরীক্ষা') returning id",
    );
    const customerId = customerResult.rows[0]!.id;
    await db.query(
      "insert into messages (page_id, customer_id, role, content, created_at) values ('demo', $1, 'user', 'test', now() + interval '1 hour')",
      [customerId],
    );
    const touched = await db.query<{ last_message_at: string }>("select last_message_at from customers where id = $1", [customerId]);
    assert.ok(Date.parse(touched.rows[0]!.last_message_at) > Date.now());

    const product = await db.query<{ id: string; price: number; stock: number }>(
      "select id, price, stock from products where page_id = 'demo' and sku = 'PJ-001'",
    );
    const zone = await db.query<{ id: string; name: string; charge: number; eta: string }>(
      "select id, name, charge, eta from delivery_zones where page_id = 'demo' and name = 'ঢাকার বাইরে'",
    );
    const item = [{ product_id: product.rows[0]!.id, name: "কটন পাঞ্জাবি (সাদা)", qty: 1, unit_price: product.rows[0]!.price }];
    const quoteResult = await db.query<{ id: string }>(
      `insert into order_quotes
        (page_id, customer_id, customer_name, phone, address, items, subtotal,
         delivery_zone_id, delivery_zone_name, delivery_charge, delivery_eta)
       values ('demo', $1, 'পরীক্ষা', '01712345678', 'বরিশাল সদর, পরীক্ষা ঠিকানা', $2::jsonb, $3,
         $4::uuid, $5, $6, $7)
       returning id`,
      [customerId, JSON.stringify(item), product.rows[0]!.price, zone.rows[0]!.id, zone.rows[0]!.name, zone.rows[0]!.charge, zone.rows[0]!.eta],
    );
    const quoteId = quoteResult.rows[0]!.id;

    const confirmed = await db.query<{ result: { ok: boolean; duplicate: boolean; order_id: string; total: number } }>(
      "select bikribot_confirm_order_quote($1::uuid, 'demo', $2::uuid) as result",
      [quoteId, customerId],
    );
    assert.equal(confirmed.rows[0]!.result.ok, true);
    assert.equal(confirmed.rows[0]!.result.duplicate, false);
    assert.equal(confirmed.rows[0]!.result.total, product.rows[0]!.price + zone.rows[0]!.charge);

    const quotePii = await db.query<{ status: string; phone: string; address: string }>(
      "select status, phone, address from order_quotes where id = $1::uuid", [quoteId],
    );
    assert.equal(quotePii.rows[0]!.status, "consumed");
    assert.equal(quotePii.rows[0]!.phone, "[গোপন]");
    assert.equal(quotePii.rows[0]!.address, "[গোপন]");

    const replay = await db.query<{ result: { ok: boolean; duplicate: boolean; order_id: string } }>(
      "select bikribot_confirm_order_quote($1::uuid, 'demo', $2::uuid) as result",
      [quoteId, customerId],
    );
    assert.equal(replay.rows[0]!.result.ok, true);
    assert.equal(replay.rows[0]!.result.duplicate, true);
    assert.equal(replay.rows[0]!.result.order_id, confirmed.rows[0]!.result.order_id);
    const afterReplay = await db.query<{ stock: number }>("select stock from products where id = $1::uuid", [product.rows[0]!.id]);
    assert.equal(afterReplay.rows[0]!.stock, product.rows[0]!.stock - 1);

    // A changed price makes the old quote stale and must not create an order.
    const secondCustomer = await db.query<{ id: string }>(
      "insert into customers (page_id, psid) values ('demo', 'test-customer-2') returning id",
    );
    await db.query(
      `insert into order_quotes (page_id, customer_id, customer_name, phone, address, items, subtotal,
        delivery_zone_id, delivery_zone_name, delivery_charge, delivery_eta)
       values ('demo', $1, 'পরীক্ষা', '01812345678', 'বরিশাল সদর, পরীক্ষা ঠিকানা', $2::jsonb, $3,
        $4::uuid, $5, $6, $7)`,
      [secondCustomer.rows[0]!.id, JSON.stringify(item), product.rows[0]!.price, zone.rows[0]!.id, zone.rows[0]!.name, zone.rows[0]!.charge, zone.rows[0]!.eta],
    );
    const staleQuote = await db.query<{ id: string }>("select id from order_quotes where customer_id = $1::uuid", [secondCustomer.rows[0]!.id]);
    await db.query("update products set price = price + 1 where id = $1::uuid", [product.rows[0]!.id]);
    const stale = await db.query<{ result: { ok: boolean; error: string } }>(
      "select bikribot_confirm_order_quote($1::uuid, 'demo', $2::uuid) as result",
      [staleQuote.rows[0]!.id, secondCustomer.rows[0]!.id],
    );
    assert.equal(stale.rows[0]!.result.ok, false);
    assert.equal(stale.rows[0]!.result.error, "QUOTE_STALE");
    await db.query("update products set price = price - 1 where id = $1::uuid", [product.rows[0]!.id]);

    // Competing equally specific zone matches are rejected instead of picking a zone by ID.
    const thirdCustomer = await db.query<{ id: string }>(
      "insert into customers (page_id, psid) values ('demo', 'test-customer-3') returning id",
    );
    const tieZones = await db.query<{ id: string }>(
      `insert into delivery_zones (page_id, name, keywords, charge, eta) values
       ('demo', 'tie-a', array['হবিগঞ্জ'], 20, '১ দিন'), ('demo', 'tie-b', array['হবিগঞ্জ'], 30, '২ দিন')
       returning id`,
    );
    await db.query(
      `insert into order_quotes (page_id, customer_id, customer_name, phone, address, items, subtotal,
        delivery_zone_id, delivery_zone_name, delivery_charge, delivery_eta)
       values ('demo', $1, 'পরীক্ষা', '01912345678', 'হবিগঞ্জ এলাকা', $2::jsonb, $3,
        $4::uuid, $5, $6, $7)`,
      [thirdCustomer.rows[0]!.id, JSON.stringify(item), product.rows[0]!.price, zone.rows[0]!.id, zone.rows[0]!.name, zone.rows[0]!.charge, zone.rows[0]!.eta],
    );
    const tieQuote = await db.query<{ id: string }>("select id from order_quotes where customer_id = $1::uuid", [thirdCustomer.rows[0]!.id]);
    const ambiguous = await db.query<{ result: { ok: boolean; error: string } }>(
      "select bikribot_confirm_order_quote($1::uuid, 'demo', $2::uuid) as result",
      [tieQuote.rows[0]!.id, thirdCustomer.rows[0]!.id],
    );
    assert.equal(ambiguous.rows[0]!.result.ok, false);
    assert.equal(ambiguous.rows[0]!.result.error, "QUOTE_STALE");
    assert.equal(tieZones.rows.length, 2);

    // Expired quotes fail without creating orders and terminal-state triggers scrub their PII.
    const fourthCustomer = await db.query<{ id: string }>(
      "insert into customers (page_id, psid) values ('demo', 'test-customer-4') returning id",
    );
    await db.query(
      `insert into order_quotes (page_id, customer_id, customer_name, phone, address, items, subtotal,
        delivery_zone_id, delivery_zone_name, delivery_charge, delivery_eta, expires_at)
       values ('demo', $1, 'পরীক্ষা', '01612345678', 'বরিশাল সদর, পরীক্ষা ঠিকানা', $2::jsonb, $3,
        $4::uuid, $5, $6, $7, now() - interval '1 minute')`,
      [fourthCustomer.rows[0]!.id, JSON.stringify(item), product.rows[0]!.price, zone.rows[0]!.id, zone.rows[0]!.name, zone.rows[0]!.charge, zone.rows[0]!.eta],
    );
    const expiredQuote = await db.query<{ id: string }>("select id from order_quotes where customer_id = $1::uuid", [fourthCustomer.rows[0]!.id]);
    const expired = await db.query<{ result: { ok: boolean; error: string } }>(
      "select bikribot_confirm_order_quote($1::uuid, 'demo', $2::uuid) as result",
      [expiredQuote.rows[0]!.id, fourthCustomer.rows[0]!.id],
    );
    assert.equal(expired.rows[0]!.result.ok, false);
    assert.equal(expired.rows[0]!.result.error, "QUOTE_EXPIRED");
    const expiredPii = await db.query<{ status: string; address: string }>("select status, address from order_quotes where id = $1::uuid", [expiredQuote.rows[0]!.id]);
    assert.equal(expiredPii.rows[0]!.status, "expired");
    assert.equal(expiredPii.rows[0]!.address, "[গোপন]");
  } finally {
    await db.close();
  }
});
