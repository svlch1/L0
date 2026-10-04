const AUTO_RIA_SEARCHES = [
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
  "https://auto.ria.com/uk/car/audi/s3/price/25000/amp/",
  "https://auto.ria.com/uk/car/audi/s4/price/25000/amp/",
  "https://auto.ria.com/uk/car/audi/s5/price/25000/amp/",
  "https://auto.ria.com/uk/car/audi/tt/price/25000/amp/",
  "https://auto.ria.com/uk/car/genesis/g70/price/25000/amp/",
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

// Every run also scans a few broad brand pages. This lets the bot discover
// unexpected models without feeding the whole AUTO.RIA market to OpenAI.
const EXPLORATION_BRANDS = [
  ["bmw", "mercedes-benz", "audi"],
  ["lexus", "infiniti", "genesis"],
  ["cadillac", "acura", "jaguar"],
  ["alfa-romeo", "volvo", "porsche"],
  ["ford", "chevrolet", "dodge"],
  ["kia", "nissan", "maserati"]
];

const AUTO_RIA_PAGES_PER_MODEL = 2;
const AUTO_RIA_DAILY_SWEEP_PAGES = 6;
const TELEGRAM_MAX_PAGES = 20;
const TELEGRAM_FORCE_RECENT_POSTS = Math.max(0, Math.min(300, Number(process.env.TELEGRAM_FORCE_RECENT_POSTS || 0)));
const FORCE_DAILY_SWEEP = process.env.FORCE_DAILY_SWEEP === "true";
const HTTP_CONCURRENCY = 8;

function kyivDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const x = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${x.year}-${x.month}-${x.day}`;
}

function dailySweepDue(state) {
  if (FORCE_DAILY_SWEEP) return true;
  return String(state?.last_daily_sweep_day || "") !== kyivDayKey();
}

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

function yearFromVin(vin) {
  const v = String(vin || "").toUpperCase().trim();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return 0;
  const map = {
    A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016,
    H: 2017, J: 2018, K: 2019, L: 2020, M: 2021, N: 2022,
    P: 2023, R: 2024, S: 2025, T: 2026
  };
  return Number(map[v[9]] || 0);
}

function extractYear(text, vin = "") {
  const vinYear = yearFromVin(vin);
  if (vinYear) return vinYear;

  // Avoid treating an AUTO.RIA update date such as 04.10.2026 as the vehicle year.
  const cleaned = String(text).replace(/\b[0-3]?\d\.[01]?\d\.20\d{2}\b/g, " ");
  const years = [...cleaned.matchAll(/\b(20(?:0[8-9]|1\d|2[0-6]))\b/g)]
    .map((m) => Number(m[1]));
  return years[0] || 0;
}

function extractDate(text) {
  const dates = [...String(text).matchAll(/\b([0-3]?\d)\.([01]?\d)\.(20\d{2})\b/g)];
  if (!dates.length) return "";
  const m = dates.at(-1);
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function modelHintFromSearchUrl(searchUrl) {
  try {
    const parts = new URL(searchUrl).pathname.split("/").filter(Boolean);
    const car = parts.indexOf("car");
    const price = parts.indexOf("price");
    if (car < 0 || price < 0 || price <= car + 1) return "";
    const bits = parts.slice(car + 1, price);
    return bits.length >= 2 ? bits.slice(0, 2).join("/") : "";
  } catch {
    return "";
  }
}

function median(values) {
  const xs = values.map(Number).filter((x) => x > 0).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function annotatePriceAnomalies(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item.model_hint || !item.model_hint.includes("/")) continue;
    if (!groups.has(item.model_hint)) groups.set(item.model_hint, []);
    groups.get(item.model_hint).push(item);
  }

  for (const item of items) {
    const group = groups.get(item.model_hint) || [];
    if (!item.price_hint_usd || group.length < 4) continue;

    let peers = group.filter((p) => {
      if (!p.price_hint_usd) return false;
      const yearOk = !item.year_hint || !p.year_hint || Math.abs(item.year_hint - p.year_hint) <= 2;
      const mileageOk =
        !item.mileage_hint_km ||
        !p.mileage_hint_km ||
        Math.abs(item.mileage_hint_km - p.mileage_hint_km) <= 40000;
      return yearOk && mileageOk;
    });

    if (peers.length < 4) peers = group.filter((p) => p.price_hint_usd > 0);
    if (peers.length < 4) continue;

    const med = median(peers.map((p) => p.price_hint_usd));
    if (!med) continue;

    item.market_median_hint_usd = Math.round(med);
    item.price_anomaly_pct = Math.round(((med - item.price_hint_usd) / med) * 1000) / 10;
  }

  return items;
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

function explorationUrls(state) {
  const run = Number(state?.completed_runs || 0);
  const group = EXPLORATION_BRANDS[run % EXPLORATION_BRANDS.length] || EXPLORATION_BRANDS[0];
  return group.map((brand) => ({
    brand,
    url: `https://auto.ria.com/uk/car/${brand}/price/25000/amp/`
  }));
}

function autoRiaPageUrls(state) {
  const dailySweep = dailySweepDue(state);
  const pageDepth = dailySweep ? AUTO_RIA_DAILY_SWEEP_PAGES : AUTO_RIA_PAGES_PER_MODEL;

  const core = AUTO_RIA_SEARCHES.flatMap((base) => {
    const urls = [{ url: base, exploration: false }];
    for (let page = 2; page <= pageDepth; page++) {
      urls.push({ url: base + "?page=" + page, exploration: false });
    }
    return urls;
  });

  const exploration = explorationUrls(state).flatMap((x) => {
    const urls = [{ url: x.url, exploration: true, exploration_brand: x.brand }];
    if (dailySweep) {
      urls.push({ url: x.url + "?page=2", exploration: true, exploration_brand: x.brand });
    }
    return urls;
  });

  return {
    core,
    exploration,
    all: [...core, ...exploration],
    daily_sweep: dailySweep,
    page_depth: pageDepth,
  };
}

function telegramPostIds(html, channel) {
  return [...String(html).matchAll(new RegExp(`data-post=["']${channel}/(\\d+)["']`, "gi"))]
    .map((m) => Number(m[1]))
    .filter(Number.isFinite);
}

async function fetchTelegramPages(channel, url, errors, cursor = {}) {
  if (TELEGRAM_FORCE_RECENT_POSTS > 0) {
    const pages = [];
    const seenSignatures = new Set();
    let nextUrl = url;
    let rawCount = 0;
    let newestSeen = Number(cursor.pending_high_water || cursor.high_water || 0);
    const pageBudget = Math.min(60, Math.max(TELEGRAM_MAX_PAGES, Math.ceil(TELEGRAM_FORCE_RECENT_POSTS / 3) + 10));

    try {
      for (let page = 0; page < pageBudget && rawCount < TELEGRAM_FORCE_RECENT_POSTS; page++) {
        const html = await fetchHtml(nextUrl);
        const ids = telegramPostIds(html, channel);
        if (!ids.length) break;
        const lowest = Math.min(...ids);
        const highest = Math.max(...ids);
        const signature = highest + ":" + lowest;
        if (seenSignatures.has(signature)) break;
        seenSignatures.add(signature);
        pages.push(html);
        rawCount += ids.length;
        newestSeen = Math.max(newestSeen, highest);
        nextUrl = url + "?before=" + lowest;
      }

      return {
        pages,
        cursor: {
          high_water: Math.max(Number(cursor.high_water || 0), newestSeen),
          pending_high_water: 0,
          backfill_before: 0,
        },
        forced_recent_posts: TELEGRAM_FORCE_RECENT_POSTS,
      };
    } catch (error) {
      errors.push(`Telegram ${channel} forced recent scan: ${String(error?.message || error)}`);
      return {
        pages,
        cursor,
        forced_recent_posts: TELEGRAM_FORCE_RECENT_POSTS,
      };
    }
  }

  const pages = [];
  const seenSignatures = new Set();
  const oldHighWater = Number(cursor.high_water || 0);
  const pendingHighWater = Number(cursor.pending_high_water || 0);
  const backfillBefore = Number(cursor.backfill_before || 0);
  let newestSeen = pendingHighWater;
  let reachedOldHighWater = oldHighWater === 0;
  let nextBackfillBefore = backfillBefore;
  let pageBudget = TELEGRAM_MAX_PAGES;

  async function grab(pageUrl) {
    if (pageBudget <= 0) return null;
    pageBudget -= 1;
    const html = await fetchHtml(pageUrl);
    const ids = telegramPostIds(html, channel);
    if (!ids.length) return null;
    const lowest = Math.min(...ids);
    const highest = Math.max(...ids);
    const signature = highest + ":" + lowest;
    if (seenSignatures.has(signature)) return null;
    seenSignatures.add(signature);
    pages.push(html);
    newestSeen = Math.max(newestSeen, highest);
    return { html, lowest, highest };
  }

  try {
    // Always cover everything newer than the previous pending frontier first.
    let latest = await grab(url);
    if (!latest) {
      return {
        pages,
        cursor: {
          high_water: oldHighWater,
          pending_high_water: pendingHighWater,
          backfill_before: backfillBefore,
        },
      };
    }

    const bridgeTarget = pendingHighWater || oldHighWater;
    let latestCursor = latest.lowest;

    while (pageBudget > 0 && bridgeTarget > 0 && latestCursor > bridgeTarget) {
      const page = await grab(url + "?before=" + latestCursor);
      if (!page) break;
      latestCursor = page.lowest;
    }

    // No pending gap: continue directly toward the last fully synced high-water mark.
    if (!backfillBefore) {
      let cursorBefore = latestCursor;
      if (oldHighWater === 0 || cursorBefore <= oldHighWater) reachedOldHighWater = true;

      while (pageBudget > 0 && !reachedOldHighWater) {
        const page = await grab(url + "?before=" + cursorBefore);
        if (!page) break;
        cursorBefore = page.lowest;
        if (cursorBefore <= oldHighWater) reachedOldHighWater = true;
      }

      if (!reachedOldHighWater && oldHighWater > 0) {
        nextBackfillBefore = cursorBefore;
      }
    } else {
      // A previous run exhausted its page budget. Continue exactly where it stopped.
      let cursorBefore = backfillBefore;

      while (pageBudget > 0 && !reachedOldHighWater) {
        const page = await grab(url + "?before=" + cursorBefore);
        if (!page) break;
        cursorBefore = page.lowest;
        if (oldHighWater === 0 || cursorBefore <= oldHighWater) reachedOldHighWater = true;
      }

      nextBackfillBefore = reachedOldHighWater ? 0 : cursorBefore;
    }

    const fullySynced = reachedOldHighWater || oldHighWater === 0;
    return {
      pages,
      cursor: fullySynced
        ? {
            high_water: newestSeen,
            pending_high_water: 0,
            backfill_before: 0,
          }
        : {
            high_water: oldHighWater,
            pending_high_water: newestSeen,
            backfill_before: nextBackfillBefore,
          },
    };
  } catch (error) {
    errors.push(`Telegram ${channel}: ${String(error?.message || error)}`);
    return {
      pages,
      cursor: {
        high_water: oldHighWater,
        pending_high_water: Math.max(pendingHighWater, newestSeen),
        backfill_before: nextBackfillBefore || backfillBefore,
      },
    };
  }
}

function autoRiaCards(html, searchUrl, exploration = false) {
  const matches = [...html.matchAll(/href=["']([^"']*\/auto_[^"']+?\.html(?:\?[^"']*)?)["']/gi)];
  const out = [];
  const seen = new Set();
  const modelHint = exploration ? "" : modelHintFromSearchUrl(searchUrl);

  for (const m of matches) {
    let href = m[1].replace(/&amp;/g, "&");
    if (href.startsWith("/")) href = "https://auto.ria.com" + href;
    if (!href.startsWith("http")) continue;

    const url = normalizeUrl(href);
    if (seen.has(url)) continue;
    seen.add(url);

    const start = Math.max(0, m.index - 1800);
    const end = Math.min(html.length, m.index + 5200);
    const text = decodeHtml(html.slice(start, end)).slice(0, 2400);
    const price = extractPriceUsd(text);
    const mileage = extractMileageKm(text);
    const vin = extractVin(text);

    if (price && price > 27000) continue;
    if (mileage && mileage > 115000) continue;

    out.push({
      source: "AUTO.RIA",
      source_url: url,
      auto_ria_url: url,
      telegram_url: "",
      vin_hint: vin,
      price_hint_usd: price,
      mileage_hint_km: mileage,
      year_hint: extractYear(text, vin),
      model_hint: modelHint,
      published_at_hint: extractDate(text),
      market_median_hint_usd: 0,
      price_anomaly_pct: 0,
      exploration,
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
    const vin = extractVin(text);

    if (!INTERESTING_BRANDS.test(text)) continue;
    if (!price || price > 27000) continue;
    if (mileage && mileage > 110000) continue;

    out.push({
      source: channel.toLowerCase() === "kievavto2" ? "KIEVAVTO" : "IsAuto",
      source_url: url,
      auto_ria_url: "",
      telegram_url: url,
      vin_hint: vin,
      price_hint_usd: price,
      mileage_hint_km: mileage,
      year_hint: extractYear(text, vin),
      model_hint: "",
      published_at_hint: "",
      market_median_hint_usd: 0,
      price_anomaly_pct: 0,
      exploration: false,
      raw_text: text,
    });
  }

  return out;
}

function existingSourceSeen(state) {
  return new Set((state?.source_seen_urls || []).map(normalizeUrl));
}

function watchByUrl(state) {
  const map = new Map();
  for (const item of Object.values(state?.market_watch || {})) {
    for (const url of [item?.source_url, item?.auto_ria_url, item?.telegram_url]) {
      if (url) map.set(normalizeUrl(url), item);
    }
  }
  return map;
}

function sourcePriceByUrl(state) {
  const map = new Map();
  for (const [url, item] of Object.entries(state?.source_price_watch || {})) {
    map.set(normalizeUrl(url), item);
  }
  return map;
}

export async function collectDirectSources(state = {}) {
  const seen = existingSourceSeen(state);
  const watched = watchByUrl(state);
  const sourcePrices = sourcePriceByUrl(state);
  const errors = [];
  const pages = autoRiaPageUrls(state);
  let autoPagesScanned = 0;

  const autoResults = await mapLimit(pages.all, HTTP_CONCURRENCY, async (page) => {
    try {
      const html = await fetchHtml(page.url);
      autoPagesScanned += 1;
      return autoRiaCards(html, page.url, Boolean(page.exploration));
    } catch (error) {
      const message = String(error?.message || error);
      if (!(page.url.includes("?page=") && message.includes("HTTP 404"))) {
        errors.push(`AUTO.RIA ${page.url}: ${message}`);
      }
      return [];
    }
  });

  const allAutoRaw = autoResults.flat();
  const allAuto = annotatePriceAnomalies(allAutoRaw);
  const autoByUrl = new Map();
  for (const item of allAuto) {
    const key = normalizeUrl(item.source_url);
    const previous = autoByUrl.get(key);
    if (!previous || (previous.exploration && !item.exploration)) autoByUrl.set(key, item);
  }

  const oldCursors = state?.telegram_cursors || {};
  const legacyHighWater = state?.telegram_high_water || {};
  const tgResults = await Promise.all(
    TELEGRAM_FEEDS.map(async ({ channel, url }) => {
      const cursor = oldCursors[channel] || {
        high_water: Number(legacyHighWater[channel] || 0),
        pending_high_water: 0,
        backfill_before: 0,
      };
      const fetched = await fetchTelegramPages(channel, url, errors, cursor);
      const byUrl = new Map();
      let rawPosts = 0;

      for (const html of fetched.pages) {
        rawPosts += telegramPostIds(html, channel).length;
        for (const item of telegramPosts(html, channel)) {
          const key = normalizeUrl(item.source_url);
          if (!byUrl.has(key)) byUrl.set(key, item);
        }
      }

      return {
        channel,
        items: [...byUrl.values()],
        pages_scanned: fetched.pages.length,
        raw_posts_seen: rawPosts,
        cursor: fetched.cursor,
      };
    })
  );

  const allTelegram = tgResults.flatMap((g) => g.items);
  const allByUrl = new Map([...autoByUrl.entries()]);
  for (const item of allTelegram) {
    const key = normalizeUrl(item.source_url);
    if (!allByUrl.has(key)) allByUrl.set(key, item);
  }

  const pool = [];
  const priceChangedItems = [];

  for (const [url, item] of allByUrl.entries()) {
    const watchedItem = watched.get(url);
    const forceTelegramReview =
      TELEGRAM_FORCE_RECENT_POSTS > 0 &&
      (item.source === "KIEVAVTO" || item.source === "IsAuto");

    if (!seen.has(url) || forceTelegramReview) {
      pool.push(forceTelegramReview ? { ...item, forced_recent_review: true } : item);
      continue;
    }

    const sourcePrice = sourcePrices.get(url);
    const oldPrice = Number(watchedItem?.last_price_usd || sourcePrice?.last_price_usd || 0);
    const newPrice = Number(item.price_hint_usd || 0);
    if (oldPrice > 0 && newPrice > 0 && newPrice < oldPrice) {
      const dropUsd = oldPrice - newPrice;
      const dropPct = (dropUsd / oldPrice) * 100;
      if (dropUsd >= 1000 || dropPct >= 5) {
        priceChangedItems.push({
          ...item,
          previous_source_price_usd: oldPrice,
          source_price_drop_usd: Math.round(dropUsd),
          source_price_drop_pct: Math.round(dropPct * 10) / 10,
        });
      }
    }
  }

  const autoPoolCount = pool.filter((x) => x.source === "AUTO.RIA").length;
  const telegramPoolCount = pool.length - autoPoolCount;
  const telegramRawPosts = tgResults.reduce((sum, g) => sum + Number(g.raw_posts_seen || 0), 0);
  const sourceHealthWarnings = [];

  // Health checks use raw parsed content, not only "new" candidates, so a quiet market is not mistaken for a parser failure.
  if (autoPagesScanned < 20 || autoByUrl.size < 20) {
    sourceHealthWarnings.push(
      `AUTO.RIA выглядит подозрительно: успешно прочитано страниц ${autoPagesScanned}, распознано объявлений ${autoByUrl.size}.`
    );
  }
  if (tgResults.some((g) => g.pages_scanned === 0 || g.raw_posts_seen === 0)) {
    const bad = tgResults
      .filter((g) => g.pages_scanned === 0 || g.raw_posts_seen === 0)
      .map((g) => g.channel)
      .join(", ");
    sourceHealthWarnings.push(`Telegram выглядит подозрительно для каналов: ${bad}.`);
  }

  return {
    pool,
    price_changed_items: priceChangedItems,
    telegram_cursors: Object.fromEntries(tgResults.map((g) => [g.channel, g.cursor])),
    exploration_brands: explorationUrls(state).map((x) => x.brand),
    daily_sweep_performed: Boolean(pages.daily_sweep),
    daily_sweep_day: pages.daily_sweep ? kyivDayKey() : String(state.last_daily_sweep_day || ""),
    source_health_warnings: sourceHealthWarnings,
    stats: {
      auto_ria_candidates: autoPoolCount,
      telegram_candidates: telegramPoolCount,
      total_candidates: pool.length,
      price_changed_candidates: priceChangedItems.length,
      auto_ria_models: AUTO_RIA_SEARCHES.length,
      exploration_brands: explorationUrls(state).map((x) => x.brand),
      auto_ria_pages_scanned: autoPagesScanned,
      auto_ria_raw_cards: autoByUrl.size,
      auto_ria_page_depth: pages.page_depth,
      daily_sweep_performed: Boolean(pages.daily_sweep),
      telegram_pages_scanned: tgResults.reduce((sum, group) => sum + Number(group.pages_scanned || 0), 0),
      telegram_raw_posts_seen: telegramRawPosts,
      telegram_channels: Object.fromEntries(tgResults.map((g) => [g.channel, {
        pages_scanned: Number(g.pages_scanned || 0),
        raw_posts_seen: Number(g.raw_posts_seen || 0),
        matching_candidates: Number(g.items?.length || 0),
        backfill_pending: Number(g.cursor?.backfill_before || 0) > 0
      }])),
      telegram_backfill_pending: tgResults.some((g) => Number(g.cursor?.backfill_before || 0) > 0),
      forced_recent_posts_per_channel: TELEGRAM_FORCE_RECENT_POSTS,
      source_errors: errors.length,
      source_health_warnings: sourceHealthWarnings.length,
    },
    errors,
  };
}

export function commitObservedUrls(state, observedUrls = []) {
  state.source_seen_urls = [
    ...new Set([...(state.source_seen_urls || []), ...observedUrls.map(normalizeUrl)])
  ].slice(-5000);
}
