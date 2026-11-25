import type { DeliveryZone, Product } from "@/lib/repo/types";

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";

/** Converts Bangla digits to ASCII. */
export function toAsciiDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

/** Normalises a Bangladeshi mobile number to 01XXXXXXXXX. Returns null if invalid. */
export function normalizeBdPhone(input: string): string | null {
  let s = toAsciiDigits(input).replace(/[\s\-().]/g, "");
  if (s.startsWith("+880")) s = "0" + s.slice(4);
  else if (s.startsWith("880")) s = "0" + s.slice(3);
  return /^01[3-9]\d{8}$/.test(s) ? s : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function tokenize(s: string): string[] {
  return toAsciiDigits(s)
    .toLowerCase()
    .split(/[\s,।.!?()\-_/]+/)
    .filter((t) => t.length > 1);
}

/** Simple, safe, language-agnostic scoring over the tenant's active catalogue. */
export function searchProductList(products: Product[], query: string, limit = 5): Product[] {
  const q = query.trim();
  if (!q) {
    return [...products].sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0)).slice(0, limit);
  }
  const tokens = tokenize(q);
  if (tokens.length === 0) return [];
  const scored = products
    .map((p) => {
      const name = p.name.toLowerCase();
      const cat = p.category.toLowerCase();
      const desc = p.description.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (name.includes(t)) score += 3;
        if (cat.includes(t)) score += 2;
        if (desc.includes(t)) score += 1;
        if (p.sku && p.sku.toLowerCase() === t) score += 5;
      }
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.p.stock > 0) - Number(a.p.stock > 0));
  return scored.slice(0, limit).map((x) => x.p);
}

/** Only a standalone, unambiguous affirmative is consent for the immediately preceding quote. */
export function isExplicitOrderConsent(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!।॥]+$/u, "")
    .replace(/\s+/g, " ");
  return /^(?:হ্যাঁ|হ্যা|জি|জ্বি|yes|yes please|confirm|confirm order|কনফার্ম|অর্ডার কনফার্ম করুন)$/u.test(
    normalized,
  );
}

export interface ZoneMatch {
  zone: DeliveryZone;
  matchedKeyword: string | null;
}

/** Longest keyword match wins; zones with no keywords act as the default/rest-of-country zone. */
export function matchDeliveryZone(zones: DeliveryZone[], address: string): ZoneMatch | null {
  const a = toAsciiDigits(address).toLowerCase();
  let bestLength = 0;
  let best: { zone: DeliveryZone; kw: string } | null = null;
  let ambiguous = false;
  for (const zone of zones) {
    for (const kw of zone.keywords) {
      const k = kw.trim().toLowerCase();
      if (!k || !a.includes(k)) continue;
      if (k.length > bestLength) {
        bestLength = k.length;
        best = { zone, kw: k };
        ambiguous = false;
      } else if (k.length === bestLength && best && best.zone.id !== zone.id) {
        ambiguous = true;
      }
    }
  }
  if (best) return ambiguous ? null : { zone: best.zone, matchedKeyword: best.kw };
  const defaults = zones.filter((z) => z.keywords.length === 0);
  return defaults.length === 1 ? { zone: defaults[0], matchedKeyword: null } : null;
}
