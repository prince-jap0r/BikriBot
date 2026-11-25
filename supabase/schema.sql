-- BikriBot schema (idempotent). Run in Supabase → SQL Editor.
-- All tables are tenant-scoped by page_id. RLS is enabled with NO policies:
-- only the server (service role key) can read/write. Never expose the service key to the browser.

create table if not exists pages (
  page_id text primary key,
  shop_name text not null default 'আমাদের শপ',
  agent_name text not null default 'রাহি',
  shop_info text not null default '',
  page_access_token text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function bikribot_preserve_page_access_token()
returns trigger
language plpgsql
as $$
begin
  if new.page_access_token is null then
    new.page_access_token := old.page_access_token;
  end if;
  return new;
end;
$$;

drop trigger if exists pages_preserve_access_token on pages;
create trigger pages_preserve_access_token
before update on pages
for each row execute function bikribot_preserve_page_access_token();

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  sku text,
  name text not null,
  description text not null default '',
  category text not null default '',
  price integer not null check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists products_page_sku_uq on products (page_id, sku);
create index if not exists products_page_idx on products (page_id);

create table if not exists delivery_zones (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  name text not null,
  keywords text[] not null default '{}',
  charge integer not null check (charge >= 0),
  eta text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists delivery_zones_page_idx on delivery_zones (page_id);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  psid text not null,
  name text,
  phone text,
  stage text not null default 'greeting',
  psych_type text not null default 'unknown',
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create unique index if not exists customers_page_psid_uq on customers (page_id, psid);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  customer_id uuid not null references customers(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  fb_mid text,
  created_at timestamptz not null default now()
);
create index if not exists messages_customer_idx on messages (customer_id, created_at desc);
create unique index if not exists messages_page_mid_uq on messages (page_id, fb_mid) where fb_mid is not null;

create or replace function bikribot_touch_customer_on_message()
returns trigger
language plpgsql
as $$
begin
  update customers
     set last_message_at = greatest(last_message_at, new.created_at)
   where id = new.customer_id and page_id = new.page_id;
  return new;
end;
$$;

drop trigger if exists messages_touch_customer on messages;
create trigger messages_touch_customer
after insert on messages
for each row execute function bikribot_touch_customer_on_message();

create table if not exists customer_memories (
  customer_id uuid primary key references customers(id) on delete cascade,
  page_id text not null,
  summary text not null default '',
  preferences jsonb not null default '{}'::jsonb,
  last_address text,
  last_order_summary text,
  total_orders integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique,
  page_id text not null,
  customer_id uuid references customers(id) on delete set null,
  customer_name text not null,
  phone text not null,
  address text not null,
  items jsonb not null,
  items_hash text not null default '',
  subtotal integer not null,
  delivery_charge integer not null default 0,
  total integer not null,
  status text not null default 'pending',
  note text,
  created_at timestamptz not null default now()
);
create index if not exists orders_page_idx on orders (page_id, created_at desc);
create index if not exists orders_customer_idx on orders (customer_id, items_hash);

-- Short-lived order snapshots. PII is retained here only while a customer reviews a quote.
create table if not exists order_quotes (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  customer_id uuid not null references customers(id) on delete cascade,
  customer_name text not null,
  phone text not null,
  address text not null,
  items jsonb not null,
  subtotal integer not null check (subtotal >= 0),
  delivery_zone_id uuid not null references delivery_zones(id),
  delivery_zone_name text not null,
  delivery_charge integer not null check (delivery_charge >= 0),
  delivery_eta text not null,
  note text,
  status text not null default 'pending' check (status in ('pending','consumed','cancelled','expired','stale')),
  order_id uuid references orders(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);
create unique index if not exists order_quotes_one_pending_per_customer
  on order_quotes (page_id, customer_id) where status = 'pending';
create index if not exists order_quotes_expiry_idx on order_quotes (expires_at) where status = 'pending';

-- Quotes are short-lived. Keep order PII only in the order row after confirmation;
-- scrub abandoned, expired, stale, cancelled, and consumed quote snapshots.
create or replace function bikribot_scrub_terminal_order_quote()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'pending' then
    new.customer_name := '[গোপন]';
    new.phone := '[গোপন]';
    new.address := '[গোপন]';
  end if;
  return new;
end;
$$;

drop trigger if exists order_quotes_scrub_terminal_pii on order_quotes;
create trigger order_quotes_scrub_terminal_pii
before update of status on order_quotes
for each row execute function bikribot_scrub_terminal_order_quote();

alter table pages enable row level security;
alter table products enable row level security;
alter table delivery_zones enable row level security;
alter table customers enable row level security;
alter table messages enable row level security;
alter table customer_memories enable row level security;
alter table orders enable row level security;
alter table order_quotes enable row level security;

-- Remove the obsolete direct-order RPC; all order commits must consume a verified quote.
drop function if exists bikribot_create_order(text, uuid, text, text, text, jsonb, integer, text);

-- Orders can only be created by consuming a pending, customer-visible quote after explicit consent.
create or replace function bikribot_confirm_order_quote(
  p_quote_id uuid,
  p_page_id text,
  p_customer_id uuid
) returns jsonb
language plpgsql
as $$
declare
  v_quote order_quotes%rowtype;
  v_zone delivery_zones%rowtype;
  v_item jsonb;
  v_prod products%rowtype;
  v_order orders%rowtype;
  v_qty integer;
  v_subtotal integer := 0;
  v_default_count integer;
  v_best_zone_count integer;
begin
  select * into v_quote from order_quotes
   where id = p_quote_id and page_id = p_page_id and customer_id = p_customer_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'QUOTE_NOT_FOUND');
  end if;
  if v_quote.status = 'consumed' and v_quote.order_id is not null then
    select * into v_order from orders where id = v_quote.order_id;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'order_id', v_order.id,
        'order_no', v_order.order_no, 'subtotal', v_order.subtotal,
        'delivery_charge', v_order.delivery_charge, 'total', v_order.total, 'items', v_order.items);
    end if;
    return jsonb_build_object('ok', false, 'error', 'QUOTE_INVALID');
  end if;
  if v_quote.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'QUOTE_INVALID');
  end if;
  if v_quote.expires_at <= now() then
    update order_quotes set status = 'expired' where id = v_quote.id;
    return jsonb_build_object('ok', false, 'error', 'QUOTE_EXPIRED');
  end if;
  if not exists (select 1 from customers c where c.id = p_customer_id and c.page_id = p_page_id) then
    update order_quotes set status = 'stale' where id = v_quote.id;
    return jsonb_build_object('ok', false, 'error', 'QUOTE_INVALID');
  end if;

  -- Resolve the current zone again. Equal-length competing matches and multiple defaults are ambiguous.
  select count(*) into v_best_zone_count
    from (
      select z.id, max(length(btrim(k.keyword))) as matched_length
        from delivery_zones z
        cross join lateral unnest(z.keywords) as k(keyword)
       where z.page_id = p_page_id and cardinality(z.keywords) > 0
         and btrim(k.keyword) <> ''
         and strpos(lower(v_quote.address), lower(btrim(k.keyword))) > 0
       group by z.id
    ) as matches
   where matches.matched_length = (
     select max(all_matches.matched_length)
       from (
         select z.id, max(length(btrim(k.keyword))) as matched_length
           from delivery_zones z
           cross join lateral unnest(z.keywords) as k(keyword)
          where z.page_id = p_page_id and cardinality(z.keywords) > 0
            and btrim(k.keyword) <> ''
            and strpos(lower(v_quote.address), lower(btrim(k.keyword))) > 0
          group by z.id
       ) as all_matches
   );
  if v_best_zone_count > 1 then
    update order_quotes set status = 'stale' where id = v_quote.id;
    return jsonb_build_object('ok', false, 'error', 'QUOTE_STALE');
  end if;

  select z.* into v_zone
    from delivery_zones z
   where z.page_id = p_page_id and cardinality(z.keywords) > 0
     and exists (select 1 from unnest(z.keywords) as k(keyword)
       where btrim(k.keyword) <> '' and strpos(lower(v_quote.address), lower(btrim(k.keyword))) > 0)
   order by (select max(length(btrim(k.keyword))) from unnest(z.keywords) as k(keyword)
       where btrim(k.keyword) <> '' and strpos(lower(v_quote.address), lower(btrim(k.keyword))) > 0) desc,
     z.id
   limit 1;
  if not found then
    select count(*) into v_default_count from delivery_zones
     where page_id = p_page_id and cardinality(keywords) = 0;
    if v_default_count <> 1 then
      update order_quotes set status = 'stale' where id = v_quote.id;
      return jsonb_build_object('ok', false, 'error', 'QUOTE_STALE');
    end if;
    select * into v_zone from delivery_zones
     where page_id = p_page_id and cardinality(keywords) = 0 limit 1;
  end if;
  if v_zone.id <> v_quote.delivery_zone_id or v_zone.charge <> v_quote.delivery_charge
     or v_zone.eta <> v_quote.delivery_eta or v_zone.name <> v_quote.delivery_zone_name then
    update order_quotes set status = 'stale' where id = v_quote.id;
    return jsonb_build_object('ok', false, 'error', 'QUOTE_STALE');
  end if;

  if jsonb_typeof(v_quote.items) <> 'array' or jsonb_array_length(v_quote.items) = 0 then
    update order_quotes set status = 'stale' where id = v_quote.id;
    return jsonb_build_object('ok', false, 'error', 'QUOTE_INVALID');
  end if;
  for v_item in select e.value from jsonb_array_elements(v_quote.items) as e order by e.value->>'product_id'
  loop
    v_qty := (v_item->>'qty')::integer;
    if v_qty < 1 or v_qty > 50 then
      update order_quotes set status = 'stale' where id = v_quote.id;
      return jsonb_build_object('ok', false, 'error', 'QUOTE_INVALID');
    end if;
    select * into v_prod from products
     where id = (v_item->>'product_id')::uuid and page_id = p_page_id and is_active
     for update;
    if not found then
      update order_quotes set status = 'stale' where id = v_quote.id;
      return jsonb_build_object('ok', false, 'error', 'QUOTE_STALE');
    end if;
    if v_prod.price <> (v_item->>'unit_price')::integer then
      update order_quotes set status = 'stale' where id = v_quote.id;
      return jsonb_build_object('ok', false, 'error', 'QUOTE_STALE');
    end if;
    if v_prod.stock < v_qty then
      return jsonb_build_object('ok', false, 'error', 'OUT_OF_STOCK', 'product', v_prod.name, 'available', v_prod.stock);
    end if;
    v_subtotal := v_subtotal + v_prod.price * v_qty;
  end loop;
  if v_subtotal <> v_quote.subtotal then
    update order_quotes set status = 'stale' where id = v_quote.id;
    return jsonb_build_object('ok', false, 'error', 'QUOTE_STALE');
  end if;

  for v_item in select e.value from jsonb_array_elements(v_quote.items) as e order by e.value->>'product_id'
  loop
    v_qty := (v_item->>'qty')::integer;
    update products set stock = stock - v_qty
     where id = (v_item->>'product_id')::uuid and page_id = p_page_id;
  end loop;

  insert into orders (order_no, page_id, customer_id, customer_name, phone, address, items,
    items_hash, subtotal, delivery_charge, total, status, note)
  values ('BB-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
    p_page_id, p_customer_id, v_quote.customer_name, v_quote.phone, v_quote.address, v_quote.items,
    '', v_subtotal, v_quote.delivery_charge, v_subtotal + v_quote.delivery_charge, 'pending', v_quote.note)
  returning * into v_order;

  update order_quotes set status = 'consumed', order_id = v_order.id where id = v_quote.id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'order_id', v_order.id,
    'order_no', v_order.order_no, 'subtotal', v_order.subtotal,
    'delivery_charge', v_order.delivery_charge, 'total', v_order.total, 'items', v_order.items);
end;
$$;

create or replace function bikribot_redact_order_details(
  p_page_id text,
  p_customer_id uuid,
  p_address text
) returns void
language sql
as $$
  update messages
     set content = regexp_replace(replace(content, p_address, '[ঠিকানা গোপন]'),
       '((\\+?880)?0?1[3-9][0-9০-৯]{8})', '[ফোন গোপন]', 'g')
   where page_id = p_page_id and customer_id = p_customer_id
     and (position(p_address in content) > 0 or content ~ '((\\+?880)?0?1[3-9][0-9০-৯]{8})');
$$;

revoke all on function bikribot_confirm_order_quote(uuid, text, uuid) from public;
revoke all on function bikribot_redact_order_details(text, uuid, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function bikribot_confirm_order_quote(uuid, text, uuid) from anon';
    execute 'revoke all on function bikribot_redact_order_details(text, uuid, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function bikribot_confirm_order_quote(uuid, text, uuid) from authenticated';
    execute 'revoke all on function bikribot_redact_order_details(text, uuid, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function bikribot_confirm_order_quote(uuid, text, uuid) to service_role';
    execute 'grant execute on function bikribot_redact_order_details(text, uuid, text) to service_role';
  end if;
end;
$$;

-- Pin search_path so session/role settings cannot shadow application objects.
alter function public.bikribot_preserve_page_access_token() set search_path = pg_catalog, public;
alter function public.bikribot_touch_customer_on_message() set search_path = pg_catalog, public;
alter function public.bikribot_scrub_terminal_order_quote() set search_path = pg_catalog, public;
alter function public.bikribot_confirm_order_quote(uuid, text, uuid) set search_path = pg_catalog, public;
alter function public.bikribot_redact_order_details(text, uuid, text) set search_path = pg_catalog, public;

-- ───────────── Demo seed (safe to re-run) ─────────────
insert into pages (page_id, shop_name, agent_name, shop_info)
values (
  'demo', 'ডেমো ফ্যাশন', 'রাহি',
  'পেমেন্ট: ক্যাশ অন ডেলিভারি, বিকাশ/নগদ। রিটার্ন: ৩ দিনের মধ্যে সাইজ/ডিফেক্ট সমস্যায় এক্সচেঞ্জ।'
) on conflict (page_id) do nothing;

insert into products (page_id, sku, name, description, category, price, stock) values
  ('demo', 'PJ-001', 'কটন পাঞ্জাবি (সাদা)', 'প্রিমিয়াম কটন, সাইজ M/L/XL, ঈদ কালেকশন', 'পাঞ্জাবি', 1450, 25),
  ('demo', 'PJ-002', 'কটন পাঞ্জাবি (নেভি ব্লু)', 'প্রিমিয়াম কটন, সাইজ M/L/XL', 'পাঞ্জাবি', 1550, 12),
  ('demo', 'SR-001', 'জামদানি শাড়ি (লাল)', 'হাতে বোনা জামদানি, ব্লাউজ পিস সহ', 'শাড়ি', 4800, 5),
  ('demo', 'SN-001', 'ক্যাজুয়াল স্নিকার্স', 'হালকা ও আরামদায়ক, সাইজ ৩৯-৪৪', 'জুতা', 2200, 0),
  ('demo', 'TS-001', 'ড্রপ শোল্ডার টি-শার্ট', 'কটন, ইউনিসেক্স, সাইজ S/M/L/XL', 'টি-শার্ট', 650, 60)
on conflict do nothing;

insert into delivery_zones (page_id, name, keywords, charge, eta)
select 'demo', 'ঢাকা সিটি', array['ঢাকা','dhaka','মিরপুর','ধানমন্ডি','উত্তরা','গুলশান','মোহাম্মদপুর','মতিঝিল','বনানী'], 60, '১-২ দিন'
where not exists (select 1 from delivery_zones where page_id = 'demo' and name = 'ঢাকা সিটি');

insert into delivery_zones (page_id, name, keywords, charge, eta)
select 'demo', 'ঢাকার বাইরে', '{}', 120, '৩-৫ দিন'
where not exists (select 1 from delivery_zones where page_id = 'demo' and name = 'ঢাকার বাইরে');
