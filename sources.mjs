const AUTO_RIA_SEARCHES = [
  // Core: максимально близко к тому, что ты ищешь.
  "https://auto.ria.com/uk/car/infiniti/q60/price/25000/amp/",
  "https://auto.ria.com/uk/car/infiniti/q50/price/25000/amp/",
  "https://auto.ria.com/uk/car/bmw/2-series/price/25000/amp/",
  "https://auto.ria.com/uk/car/bmw/3-series/price/25000/amp/",
  "https://auto.ria.com/uk/car/bmw/4-series/price/25000/amp/",
  "https://auto.ria.com/uk/car/bmw/4-series-gran-coupe/price/25000/amp/",
  "https://auto.ria.com/uk/car/mercedes-benz/c-class/price/25000/amp/",
  "https://auto.ria.com/uk/car/mercedes-benz/cla-class/price/25000/amp/",
  "https://auto.ria.com/uk/car/lexus/rc/price/25000/amp/",
  "https://auto.ria.com/uk/car/lexus/is/price/25000/amp/",
  "https://auto.ria.com/uk/car/audi/a5/price/25000/amp/",
  "https://auto.ria.com/uk/car/audi/s4/price/25000/amp/",
  "https://auto.ria.com/uk/car/audi/s5/price/25000/amp/",
  "https://auto.ria.com/uk/car/audi/tt/price/25000/amp/",
  "https://auto.ria.com/uk/car/genesis/g70/price/25000/amp/",

  // Exploration: могут быть менее очевидны, но сильная цена/комплектация должна иметь шанс.
  "https://auto.ria.com/uk/car/bmw/5-series/price/25000/amp/",
  "https://auto.ria.com/uk/car/bmw/6-series-gran-coupe/price/25000/amp/",
  "https://auto.ria.com/uk/car/mercedes-benz/e-class/price/25000/amp/",
  "https://auto.ria.com/uk/car/mercedes-benz/cls-class/price/25000/amp/",
  "https://auto.ria.com/uk/car/lexus/gs/price/25000/amp/",
  "https://auto.ria.com/uk/car/audi/a4/price/25000/amp/",
  "https://auto.ria.com/uk/car/genesis/g80/price/25000/amp/",
  "https://auto.ria.com/uk/car/cadillac/ats/price/25000/amp/",
  "https://auto.ria.com/uk/car/cadillac/cts/price/25000/amp/",
  "https://auto.ria.com/uk/car/acura/tlx/price/25000/amp/",
  "https://auto.ria.com/uk/car/jaguar/xe/price/25000/amp/",
  "https://auto.ria.com/uk/car/alfa-romeo/giulia/price/25000/amp/",
  "https://auto.ria.com/uk/car/ford/mustang/price/25000/amp/",
  "https://auto.ria.com/uk/car/chevrolet/camaro/price/25000/amp/",
  "https://auto.ria.com/uk/car/dodge/challenger/price/25000/amp/",
  "https://auto.ria.com/uk/car/kia/stinger/price/25000/amp/",
  "https://auto.ria.com/uk/car/volvo/s60/price/25000/amp/",
  "https://auto.ria.com/uk/car/nissan/370z/price/25000/amp/"
];

const AUTO_RIA_PAGES_PER_MODEL = 2;
const TELEGRAM_MAX_PAGES = 6;
const HTTP_CONCURRENCY = 8;

const TELEGRAM_FEEDS = [
  { channel: "kievavto2", url: "https://t.me/s/kievavto2" },
  { channel: "isAuto99", url: "https://t.me/s/isAuto99" },
];

const INTERESTING_BRANDS = /\b(?:BMW|Mercedes(?:-Benz)?|Infiniti|Lexus|Audi|Genesis|Porsche|Jaguar|Cadillac|Acura|Volvo|Mustang|Camaro|Challenger|Maserati|Alfa\s+Romeo|Giulia|Stinger|370Z)\b/i;

function decodeHtml(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeUrl(url) {
  return String(url || "")
    .replace(/&amp;/g, "&")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function extractPriceUsd(text) {
  const values = [];
  for (const m of String(text).matchAll(/(?:\$\s*)?(\d{1,3}(?:[ .]\d{3})+|\d{4,6})\s*\$/g)) {
    const n = Number(m[1].replace(/[ .]/g, ""));
    if (n >= 3000 && n <= 300000) values.push(n);
  }
  return values[0] || 0;
}

function extractMileageKm(text) {
  let m = String(text).match(/(\d{1,3}(?:[.,]\d+)?)\s*(?:тис|тыс|k)\.?\s*км/i);
  if (m) return Math.round(Number(m[1].replace(",", ".")) * 1000);
  m = String(text).match(/(\d{1,3}(?:[ .]\d{3})?)\s*км/i);
  if (m) {
    const n = Number(m[1].replace(/ /g, ""));
    if (n >= 1000) return n;
  }
  return 0;
}

function extractVin(text) {
  const vins = [...String(text).toUpperCase().matchAll(/\b[A-HJ-NPR-Z0-9]{17}\b/g)]
    .map((m) => m[0]);
  return vins[0] || "";
}

function extractDate(text) {
  const dates = [...String(text).matchAll(/\b([0-3]?\d)\.([01]?\d)\.(20\d{2})\b/g)];
  if (!dates.length) return "";
  const m = dates.at(-1);
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; CarGemScout/1.0; +https://github.com/svlch1/L0)",
        "accept-language": "uk-UA,uk;q=0.9,en;q=0.7",
      },
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;

  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return out;
}

function autoRiaPageUrls() {
  return AUTO_RIA_SEARCHES.flatMap((base) => {
    const urls = [base];
    for (let page = 2; page <= AUTO_RIA_PAGES_PER_MODEL; page++) {
      urls.push(base + "?page=" + page);
    }
    return urls;
  });
}

function telegramPostIds(html, channel) {
  return [...String(html).matchAll(new RegExp(`data-post=["']${channel}/(\\d+)["']`, "gi"))]
    .map((m) => Number(m[1]))
    .filter(Number.isFinite);
}

async function fetchTelegramPages(channel, url, errors) {
  const pages = [];
  let nextUrl = url;
  const seenPageStarts = new Set();

  for (let page = 0; page < TELEGRAM_MAX_PAGES; page++) {
    try {
      const html = await fetchHtml(nextUrl);
      const ids = telegramPostIds(html, channel);
      if (!ids.length) break;

      const lowest = Math.min(...ids);
      const highest = Math.max(...ids);
      const signature = highest + ":" + lowest;
      if (seenPageStarts.has(signature)) break;
      seenPageStarts.add(signature);

      pages.push(html);
      nextUrl = url + "?before=" + lowest;
    } catch (error) {
      errors.push(`Telegram ${channel} page ${page + 1}: ${String(error?.message || error)}`);
      break;
    }
  }

  return pages;
}

function autoRiaCards(html, searchUrl) {
  const matches = [...html.matchAll(/href=["']([^"']*\/auto_[^"']+?\.html(?:\?[^"']*)?)["']/gi)];
  const out = [];
  const seen = new Set();

  for (const m of matches) {
    let href = m[1].replace(/&amp;/g, "&");
    if (href.startsWith("/")) href = "https://auto.ria.com" + href;
    if (!href.startsWith("http")) continue;
    const url = normalizeUrl(href);
    if (seen.has(url)) continue;
    seen.add(url);

    const start = Math.max(0, m.index - 1800);
    const end = Math.min(html.length, m.index + 5200);
    const text = decodeHtml(html.slice(start, end)).slice(0, 2200);
    const price = extractPriceUsd(text);
    const mileage = extractMileageKm(text);

    // Search page is already capped by price; this only removes obvious bad matches.
    if (price && price > 27000) continue;
    if (mileage && mileage > 115000) continue;

    out.push({
      source: "AUTO.RIA",
      source_url: url,
      auto_ria_url: url,
      telegram_url: "",
      vin_hint: extractVin(text),
      price_hint_usd: price,
      mileage_hint_km: mileage,
      published_at_hint: extractDate(text),
      raw_text: text,
      search_url: searchUrl,
    });
  }

  return out;
}

function telegramPosts(html, channel) {
  const markers = [...html.matchAll(new RegExp(`data-post=["']${channel}/(\\d+)["']`, "gi"))];
  const out = [];

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index;
    const end = i + 1 < markers.length ? markers[i + 1].index : Math.min(html.length, start + 30000);
    const text = decodeHtml(html.slice(start, end)).slice(0, 4000);
    const id = markers[i][1];
    const url = `https://t.me/${channel}/${id}`;
    const price = extractPriceUsd(text);
    const mileage = extractMileageKm(text);

    if (!INTERESTING_BRANDS.test(text)) continue;
    if (!price || price > 27000) continue;
    if (mileage && mileage > 110000) continue;

    out.push({
      source: channel.toLowerCase() === "kievavto2" ? "KIEVAVTO" : "IsAuto",
      source_url: url,
      auto_ria_url: "",
      telegram_url: url,
      vin_hint: extractVin(text),
      price_hint_usd: price,
      mileage_hint_km: mileage,
      published_at_hint: "",
      raw_text: text,
    });
  }

  return out;
}

function watchedUrls(state) {
  return new Set(
    Object.values(state?.market_watch || {})
      .flatMap((x) => [x?.auto_ria_url, x?.telegram_url, x?.source_url])
      .filter(Boolean)
      .map(normalizeUrl)
  );
}

function existingSourceSeen(state) {
  return new Set((state?.source_seen_urls || []).map(normalizeUrl));
}

export async function collectDirectSources(state = {}) {
  const seen = existingSourceSeen(state);
  const watched = watchedUrls(state);
  const observed = new Set();
  const errors = [];
  let autoItems = [];

  const autoUrls = autoRiaPageUrls();
  let autoPagesScanned = 0;
  const autoResults = await mapLimit(autoUrls, HTTP_CONCURRENCY, async (url) => {
    try {
      const html = await fetchHtml(url);
      autoPagesScanned += 1;
      return autoRiaCards(html, url);
    } catch (error) {
      const message = String(error?.message || error);
      // 404 на ?page=2 означает, что у модели просто нет второй страницы.
      if (!(url.includes("?page=") && message.includes("HTTP 404"))) {
        errors.push(`AUTO.RIA ${url}: ${message}`);
      }
      return [];
    }
  });

  for (const group of autoResults) {
    for (const item of group) {
      const url = normalizeUrl(item.source_url);
      observed.add(url);
      if (!seen.has(url) || watched.has(url)) autoItems.push(item);
    }
  }

  // Prefer freshest cards where AUTO.RIA exposes a date, then low-mileage/known-price items.
  autoItems.sort((a, b) => {
    const ad = a.published_at_hint ? Date.parse(a.published_at_hint) : 0;
    const bd = b.published_at_hint ? Date.parse(b.published_at_hint) : 0;
    if (bd !== ad) return bd - ad;
    const am = a.mileage_hint_km || 999999;
    const bm = b.mileage_hint_km || 999999;
    return am - bm;
  });

  const byUrl = new Map();
  for (const item of autoItems) {
    const key = normalizeUrl(item.source_url);
    if (!byUrl.has(key)) byUrl.set(key, item);
  }
  autoItems = [...byUrl.values()].slice(0, 24);

  let telegramItems = [];
  const tgResults = await Promise.all(
    TELEGRAM_FEEDS.map(async ({ channel, url }) => {
      const pages = await fetchTelegramPages(channel, url, errors);
      const byUrl = new Map();

      for (const html of pages) {
        for (const item of telegramPosts(html, channel)) {
          const key = normalizeUrl(item.source_url);
          if (!byUrl.has(key)) byUrl.set(key, item);
        }
      }

      return { items: [...byUrl.values()], pages_scanned: pages.length };
    })
  );

  for (const group of tgResults) {
    for (const item of group.items) {
      const normalized = normalizeUrl(item.source_url);
      observed.add(normalized);
      if (!seen.has(normalized)) telegramItems.push(item);
    }
  }

  telegramItems = telegramItems
    .sort((a, b) => Number(b.source_url.match(/\/(\d+)$/)?.[1] || 0) - Number(a.source_url.match(/\/(\d+)$/)?.[1] || 0))
    .slice(0, 12);

  const items = [...autoItems, ...telegramItems].slice(0, 32);

  return {
    items,
    observed_urls: [...observed],
    stats: {
      auto_ria_candidates: autoItems.length,
      telegram_candidates: telegramItems.length,
      total_candidates: items.length,
      auto_ria_models: AUTO_RIA_SEARCHES.length,
      auto_ria_pages_scanned: autoPagesScanned,
      telegram_pages_scanned: tgResults.reduce((sum, group) => sum + Number(group.pages_scanned || 0), 0),
      source_errors: errors.length,
    },
    errors,
  };
}

export function commitObservedUrls(state, observedUrls = []) {
  state.source_seen_urls = [
    ...new Set([...(state.source_seen_urls || []), ...observedUrls.map(normalizeUrl)])
  ].slice(-3000);
}
