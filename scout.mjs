import fs from "node:fs";
import crypto from "node:crypto";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TEST_ONLY = process.env.TEST_ONLY === "true";

async function telegram(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

function encryptChatId(chatId) {
  const key = crypto.createHash("sha256").update(TELEGRAM_BOT_TOKEN).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(chatId), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptChatId(payload) {
  try {
    if (!payload?.iv || !payload?.tag || !payload?.data) return null;
    const key = crypto.createHash("sha256").update(TELEGRAM_BOT_TOKEN).digest();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(payload.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

async function getChatId() {
  const state = loadSeen();
  const savedChatId = decryptChatId(state.telegram_chat);
  if (savedChatId) return savedChatId;

  for (let attempt = 1; attempt <= 12; attempt++) {
    const updates = await telegram("getUpdates", { limit: 100, timeout: 20 });
    const privateMessages = updates
      .map((u) => u.message)
      .filter((m) => m?.chat?.id && m.chat.type === "private");

    if (privateMessages.length) {
      const chatId = String(privateMessages.at(-1).chat.id);
      state.telegram_chat = encryptChatId(chatId);
      fs.writeFileSync("seen.json", JSON.stringify(state, null, 2) + "\n");
      console.log("Telegram destination discovered and encrypted.");
      return chatId;
    }

    console.log(`Waiting for /start in @DanilCarGemBot... attempt ${attempt}/12`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error("No Telegram private chat found after waiting for /start.");
}

async function sendText(chatId, text) {
  let rest = text.trim();
  while (rest.length) {
    let cut = Math.min(3900, rest.length);
    if (rest.length > 3900) {
      const nl = rest.lastIndexOf("\n", 3900);
      if (nl > 2500) cut = nl;
    }
    const chunk = rest.slice(0, cut).trim();
    rest = rest.slice(cut).trim();
    if (!chunk) continue;
    await telegram("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 1300));
  }
}

function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync("seen.json", "utf8"));
  } catch {
    return { vins: [], urls: [] };
  }
}

function saveSeen(seen, text) {
  const vins = [...text.matchAll(/\b[A-HJ-NPR-Z0-9]{17}\b/g)].map((m) => m[0]);
  const urls = [...text.matchAll(/https?:\/\/[^\s<>()]+/g)].map((m) => m[0].replace(/[.,;]+$/, ""));
  seen.vins = [...new Set([...(seen.vins || []), ...vins])].slice(-500);
  seen.urls = [...new Set([...(seen.urls || []), ...urls])].slice(-1000);
  fs.writeFileSync("seen.json", JSON.stringify(seen, null, 2) + "\n");
}


function saveState(state) {
  fs.writeFileSync("seen.json", JSON.stringify(state, null, 2) + "\n");
}

function formatKyiv(iso) {
  if (!iso) return "ещё не было";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Kyiv",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function nextScheduledCheck() {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(Math.floor(d.getUTCHours() / 4) * 4 + 4);
  return d.toISOString();
}

function statusText(state) {
  let result = "ещё нет завершённых проверок";
  if (state.last_check_status === "no_gem") {
    result = "ничего достойного не найдено";
  } else if (state.last_check_status === "found") {
    result = `найдено и показано: ${state.last_sent_count || 0}`;
  } else if (state.last_check_status === "error") {
    result = `ошибка: ${state.last_error || "неизвестная"}`;
  }

  return [
    "🟢 Car Gem Scout работает",
    "",
    "⏱ Режим: каждые 4 часа / 6 раз в сутки",
    `🕒 Последняя проверка: ${formatKyiv(state.last_check_at)}`,
    `🔎 Результат: ${result}`,
    `📊 Всего показано гемов: ${state.total_gems_sent || 0}`,
    `🔁 Всего завершённых проходов: ${state.completed_runs || 0}`,
    `⏭ Следующая плановая проверка: ~${formatKyiv(nextScheduledCheck())}`,
    "",
    "Источники: AUTO.RIA + KIEVAVTO + IsAuto",
    "Фильтр: только реальные ГЕМЫ ≥ 8.5/10",
  ].join("\n");
}

function splitGems(text) {
  const parts = text
    .split(/(?=🔥\s*ГЕМ\s*\/\s*СМОТРЕТЬ\s*СРОЧНО)/i)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}


function outputText(data) {
  return (data.output || [])
    .filter((x) => x.type === "message")
    .flatMap((x) => x.content || [])
    .filter((x) => x.type === "output_text")
    .map((x) => x.text || "")
    .join("\n")
    .trim();
}

async function openaiJson({ prompt, schema, name, effort = "medium", maxOutputTokens = 5000, background = false }) {
  const payload = {
    model: "gpt-6.1-sol",
    reasoning: { effort },
    tools: [{
      type: "web_search",
      search_context_size: "high",
      user_location: {
        type: "approximate",
        country: "UA",
        timezone: "Europe/Kyiv"
      }
    }],
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name,
        strict: true,
        schema,
      }
    },
    max_output_tokens: maxOutputTokens,
    store: false,
  };

  if (background) payload.background = true;

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await r.text();
  if (!r.ok) throw new Error(`OpenAI API failed ${r.status}: ${raw.slice(0, 1200)}`);
  let data = JSON.parse(raw);

  if (background) {
    if (!data.id) throw new Error("Background response did not return an id");

    const deadline = Date.now() + 15 * 60 * 1000;
    let pollCount = 0;
    let lastLoggedStatus = "";
    while ((data.status === "queued" || data.status === "in_progress") && Date.now() < deadline) {
      if (data.status !== lastLoggedStatus || pollCount % 6 === 0) {
        console.log(`OpenAI background response ${data.id}: ${data.status}`);
        lastLoggedStatus = data.status;
      }
      pollCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10000));

      const poll = await fetch("https://api.openai.com/v1/responses/" + encodeURIComponent(data.id), {
        headers: {
          authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      });
      const pollRaw = await poll.text();
      if (!poll.ok) {
        throw new Error(`OpenAI background poll failed ${poll.status}: ${pollRaw.slice(0, 1200)}`);
      }
      data = JSON.parse(pollRaw);
    }

    if (data.status === "queued" || data.status === "in_progress") {
      throw new Error("OpenAI background response timed out after 15 minutes");
    }
    if (data.status !== "completed") {
      throw new Error(
        "OpenAI background response ended with status=" + String(data.status || "unknown") +
        "; error=" + JSON.stringify(data.error || data.incomplete_details || null)
      );
    }
  }

  const text = outputText(data);
  if (!text) throw new Error("OpenAI returned empty structured output");
  try {
    return JSON.parse(text);
  } catch (error) {
    const incomplete = data.incomplete_details ? JSON.stringify(data.incomplete_details) : "none";
    throw new Error(
      "Structured JSON parse failed; response_status=" + String(data.status || "unknown") +
      "; incomplete=" + incomplete +
      "; chars=" + text.length +
      "; tail=" + text.slice(-700)
    );
  }
}

const discoverySchema = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string" },
          source_url: { type: "string" },
          auto_ria_url: { type: "string" },
          telegram_url: { type: "string" },
          vin: { type: "string" },
          model: { type: "string" },
          year: { type: "integer" },
          price_usd: { type: "integer" },
          mileage_km: { type: "integer" },
          engine: { type: "string" },
          transmission: { type: "string" },
          drive: { type: "string" },
          location: { type: "string" },
          seller_type: { type: "string" },
          listing_note: { type: "string" },
          why_candidate: { type: "string" },
          discovery_score: { type: "number" }
        },
        required: [
          "source","source_url","auto_ria_url","telegram_url","vin","model","year",
          "price_usd","mileage_km","engine","transmission","drive","location",
          "seller_type","listing_note","why_candidate","discovery_score"
        ],
        additionalProperties: false
      }
    }
  },
  required: ["candidates"],
  additionalProperties: false
};

const analysisSchema = {
  type: "object",
  properties: {
    analyses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidate_key: { type: "string" },
          model: { type: "string" },
          year: { type: "integer" },
          trim: { type: "string" },
          price_usd: { type: "integer" },
          mileage_km: { type: "integer" },
          engine_transmission_drive: { type: "string" },
          zero_to_100: { type: "string" },
          vin: { type: "string" },
          auto_ria_url: { type: "string" },
          telegram_url: { type: "string" },
          history_url: { type: "string" },
          auction_lot_date: { type: "string" },
          primary_secondary_damage: { type: "string" },
          run_drive_starts: { type: "string" },
          airbags: { type: "string" },
          structure: { type: "string" },
          flood_water: { type: "string" },
          auction_mileage: { type: "string" },
          pre_repair_photos_summary: { type: "string" },
          estimated_repair_cost_usd: { type: "integer" },
          acv_usd: { type: "integer" },
          retail_value_usd: { type: "integer" },
          final_bid_usd: { type: "integer" },
          repair_acv_pct: { type: "number" },
          weak_points: { type: "string" },
          inspection_checklist: { type: "string" },
          major_expense_risk: { type: "string", enum: ["низкий","средний","высокий"] },
          seller_risk: { type: "string" },
          listing_inconsistencies: { type: "string" },
          market_low_usd: { type: "integer" },
          market_high_usd: { type: "integer" },
          resale_1y_low_usd: { type: "integer" },
          resale_1y_high_usd: { type: "integer" },
          resale_2y_low_usd: { type: "integer" },
          resale_2y_high_usd: { type: "integer" },
          expected_loss_note: { type: "string" },
          real_buy_in_low_usd: { type: "integer" },
          real_buy_in_high_usd: { type: "integer" },
          target_buy_price_usd: { type: "integer" },
          confidence_pct: { type: "integer" },
          price_score: { type: "number" },
          history_score: { type: "number" },
          technical_score: { type: "number" },
          liquidity_score: { type: "number" },
          emotion_score: { type: "number" },
          trim_score: { type: "number" },
          why_gem: {
            type: "array",
            items: { type: "string" }
          },
          hard_reject: { type: "boolean" },
          hard_reject_reason: { type: "string" },
          verdict: { type: "string" }
        },
        required: [
          "candidate_key","model","year","trim","price_usd","mileage_km",
          "engine_transmission_drive","zero_to_100","vin","auto_ria_url","telegram_url",
          "history_url","auction_lot_date","primary_secondary_damage","run_drive_starts",
          "airbags","structure","flood_water","auction_mileage","pre_repair_photos_summary",
          "estimated_repair_cost_usd","acv_usd","retail_value_usd","final_bid_usd",
          "repair_acv_pct","weak_points","inspection_checklist","major_expense_risk",
          "seller_risk","listing_inconsistencies","market_low_usd","market_high_usd",
          "resale_1y_low_usd","resale_1y_high_usd","resale_2y_low_usd",
          "resale_2y_high_usd","expected_loss_note","real_buy_in_low_usd",
          "real_buy_in_high_usd","target_buy_price_usd","confidence_pct",
          "price_score","history_score","technical_score","liquidity_score",
          "emotion_score","trim_score","why_gem","hard_reject","hard_reject_reason","verdict"
        ],
        additionalProperties: false
      }
    }
  },
  required: ["analyses"],
  additionalProperties: false
};

function normalizeUrl(url) {
  return String(url || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
}

function candidateKey(candidate) {
  const vin = String(candidate.vin || "").toUpperCase().trim();
  if (/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return "VIN:" + vin;
  const url = normalizeUrl(candidate.auto_ria_url || candidate.telegram_url || candidate.source_url);
  return "URL:" + crypto.createHash("sha1").update(url || JSON.stringify(candidate)).digest("hex").slice(0, 16);
}

function ensureMarketWatch(state) {
  if (!state.market_watch || typeof state.market_watch !== "object" || Array.isArray(state.market_watch)) {
    state.market_watch = {};
  }
  return state.market_watch;
}

function compactWatchlist(state) {
  const watch = ensureMarketWatch(state);
  return Object.entries(watch)
    .sort((a, b) => String(b[1].last_seen_at || "").localeCompare(String(a[1].last_seen_at || "")))
    .slice(0, 80)
    .map(([key, x]) => ({
      key,
      model: x.model || "",
      vin: x.vin || "",
      url: x.auto_ria_url || x.telegram_url || x.source_url || "",
      last_price_usd: Number(x.last_price_usd || 0),
      target_buy_price_usd: Number(x.target_buy_price_usd || 0),
      alerted: Boolean(x.alerted),
      last_score: Number(x.last_score || 0),
    }));
}

function recordDiscoveredCandidate(state, candidate, nowIso) {
  const watch = ensureMarketWatch(state);
  const key = candidateKey(candidate);
  const prev = watch[key] || {};
  const oldPrice = Number(prev.last_price_usd || 0);
  const newPrice = Number(candidate.price_usd || 0);
  const dropUsd = oldPrice > 0 && newPrice > 0 && newPrice < oldPrice ? oldPrice - newPrice : 0;
  const dropPct = oldPrice > 0 && dropUsd > 0 ? (dropUsd / oldPrice) * 100 : 0;
  const hitTarget = Number(prev.target_buy_price_usd || 0) > 0 &&
    newPrice > 0 &&
    newPrice <= Number(prev.target_buy_price_usd);

  const item = {
    ...prev,
    key,
    model: candidate.model,
    year: candidate.year,
    vin: String(candidate.vin || "").toUpperCase(),
    source: candidate.source,
    source_url: candidate.source_url,
    auto_ria_url: candidate.auto_ria_url,
    telegram_url: candidate.telegram_url,
    mileage_km: candidate.mileage_km,
    engine: candidate.engine,
    transmission: candidate.transmission,
    drive: candidate.drive,
    seller_type: candidate.seller_type,
    listing_note: candidate.listing_note,
    first_seen_at: prev.first_seen_at || nowIso,
    last_seen_at: nowIso,
    last_price_usd: newPrice,
    lowest_price_usd: prev.lowest_price_usd
      ? Math.min(Number(prev.lowest_price_usd), newPrice || Number(prev.lowest_price_usd))
      : newPrice,
  };

  item.price_history = Array.isArray(prev.price_history) ? prev.price_history.slice(-19) : [];
  if (newPrice > 0 && (!item.price_history.length || item.price_history.at(-1)?.price_usd !== newPrice)) {
    item.price_history.push({ at: nowIso, price_usd: newPrice });
  }

  watch[key] = item;

  const neverAnalyzed = !prev.last_analyzed_at;
  const priceDropTrigger = dropUsd >= 1000 || dropPct >= 5;
  const targetTrigger = hitTarget && Number(prev.last_analyzed_price_usd || 0) !== newPrice;

  return {
    ...candidate,
    candidate_key: key,
    previous_price_usd: oldPrice,
    price_drop_usd: Math.round(dropUsd),
    price_drop_pct: Math.round(dropPct * 10) / 10,
    price_drop_trigger: priceDropTrigger,
    target_price_trigger: targetTrigger,
    never_analyzed: neverAnalyzed,
    previously_alerted: Boolean(prev.alerted),
    previous_score: Number(prev.last_score || 0),
    previous_target_buy_price_usd: Number(prev.target_buy_price_usd || 0),
  };
}

function weightedScore(a) {
  const clamp = (n) => Math.max(0, Math.min(10, Number(n || 0)));
  return Math.round((
    clamp(a.price_score) * 0.25 +
    clamp(a.history_score) * 0.25 +
    clamp(a.technical_score) * 0.20 +
    clamp(a.liquidity_score) * 0.15 +
    clamp(a.emotion_score) * 0.10 +
    clamp(a.trim_score) * 0.05
  ) * 100) / 100;
}

function money(n) {
  n = Number(n || 0);
  return n > 0 ? "$" + Math.round(n).toLocaleString("en-US") : "нет данных";
}

function candidateUrls(a) {
  const rows = [];
  if (a.auto_ria_url) rows.push("AUTO.RIA: " + a.auto_ria_url);
  else rows.push("AUTO.RIA: нет");
  if (a.telegram_url) rows.push("Telegram: " + a.telegram_url);
  else rows.push("Telegram: нет");
  if (a.history_url) rows.push("История США / лот / фото: " + a.history_url);
  else rows.push("История США / лот / фото: нет данных");
  return rows.join("\n");
}

function formatGemAlert(a, score, priceMeta = {}) {
  const why = (a.why_gem || []).slice(0, 4).map((x) => "— " + x).join("\n") || "— Сильная совокупность цены, состояния и ликвидности.";
  const priceDrop = priceMeta.price_drop_trigger
    ? `\n📉 PRICE DROP: ${money(priceMeta.previous_price_usd)} → ${money(a.price_usd)} (-${money(priceMeta.price_drop_usd).replace("$","$")}, ${priceMeta.price_drop_pct}%)`
    : "";

  return `🔥 ГЕМ / СМОТРЕТЬ СРОЧНО — ${a.model} ${a.year} ${a.trim}${priceDrop}

💵 Цена: ${money(a.price_usd)}
🛣 Пробег: ${a.mileage_km > 0 ? a.mileage_km.toLocaleString("ru-RU") + " км" : "нет данных"}
⚙️ ${a.engine_transmission_drive}
🏁 0–100: ${a.zero_to_100}
⭐ Рейтинг покупки: ${score}/10
🎯 Уверенность: ${a.confidence_pct}%

📊 РАЗБИВКА РЕЙТИНГА
Цена / рынок: ${a.price_score}/10
История / состояние: ${a.history_score}/10
Техника / риск расходов: ${a.technical_score}/10
Ликвидность: ${a.liquidity_score}/10
Эмоции / динамика: ${a.emotion_score}/10
Комплектация: ${a.trim_score}/10

🔗 ГДЕ НАШЁЛ
${candidateUrls(a)}

💎 ПОЧЕМУ ЭТО ГЕМ
${why}

🇺🇸 ИСТОРИЯ США
VIN: ${a.vin || "нет данных"}
Аукцион / lot / дата: ${a.auction_lot_date}
Primary / Secondary Damage: ${a.primary_secondary_damage}
Run & Drive / Starts: ${a.run_drive_starts}
Airbags: ${a.airbags}
Силовая структура: ${a.structure}
Flood/Water: ${a.flood_water}
Пробег на аукционе: ${a.auction_mileage}
Фото до ремонта: ${a.pre_repair_photos_summary}
Estimated Repair Cost: ${money(a.estimated_repair_cost_usd)}
ACV: ${money(a.acv_usd)}
Retail Value: ${money(a.retail_value_usd)}
Final Bid: ${money(a.final_bid_usd)}
Repair Estimate / ACV: ${a.repair_acv_pct > 0 ? a.repair_acv_pct + "%" : "нет данных"}

🔧 ТЕХНИКА
Типичные слабые места: ${a.weak_points}
Что проверить: ${a.inspection_checklist}
Риск крупных расходов: ${a.major_expense_risk}
Риск по продавцу/объявлению: ${a.seller_risk}
Несостыковки: ${a.listing_inconsistencies}

💰 ДЕНЬГИ
Рынок аналогов: ${money(a.market_low_usd)}–${money(a.market_high_usd)}
Real Buy-In Cost первые ~6 мес.: ${money(a.real_buy_in_low_usd)}–${money(a.real_buy_in_high_usd)}
Цена, при которой точно интересно: ${money(a.target_buy_price_usd)}
Перепродажа ~1 год: ${money(a.resale_1y_low_usd)}–${money(a.resale_1y_high_usd)}
Перепродажа ~2 года: ${money(a.resale_2y_low_usd)}–${money(a.resale_2y_high_usd)}
Ожидаемая потеря: ${a.expected_loss_note}

🏁 ВЕРДИКТ
${a.verdict}`;
}

async function discoverCandidates(state) {
  const watchlist = compactWatchlist(state);
  const prompt = `
Ты — DISCOVERY-этап Car Gem Scout для покупки первой машины в Украине.

ТВОЯ ЗАДАЧА СЕЙЧАС НЕ ДЕЛАТЬ ГЛУБОКИЙ АНАЛИЗ.
Сначала максимально полно найди СВЕЖИЕ актуальные объявления-кандидаты, чтобы второй этап уже отдельно глубоко проверял VIN/аукционы/технику.

ОБЯЗАТЕЛЬНО ПРОВЕРЬ:
1) AUTO.RIA по Украине.
2) KIEVAVTO: https://t.me/kievavto2 и https://t.me/s/kievavto2
3) IsAuto: https://t.me/isAuto99 и доступные публичные/индексированные посты.

ШИРОКИЙ ФИЛЬТР DISCOVERY:
- ориентир бюджета до $25,000; допускай до ~$26,500 только если очевиден торг/аномально сильный вариант;
- пробег желательно <=70k км, но до ~90k можно оставить кандидатом для сильной модели/цены;
- эффектный спортивный/премиальный автомобиль, первая машина должна вызывать эмоции;
- динамика желательно около 6 сек 0–100 или быстрее;
- главный ориентир Infiniti Q60;
- также BMW coupe/3/4-series хороших конфигураций, Mercedes coupe/CLA/C-Class, Lexus RC/IS, Audi и аналогичные интересные автомобили;
- не тащи скучные массовые седаны типа Accord;
- Kia Stinger только если реально аномальная сделка;
- пока НЕ отбрасывай умеренно битых американцев, если они потенциально могут быть хорошей покупкой — это проверит второй этап;
- flood/fire/очевидный тяжёлый структурный хлам можешь не включать сразу.

Найди максимум 10 реальных актуальных кандидатов. Для каждого поставь discovery_score 0–10 — предварительную оценку соответствия моим критериям ДО глубокого VIN-анализа.
В source_url давай ПРЯМУЮ ссылку на конкретное объявление/пост.
Не выдумывай VIN, цену, пробег или URL. Если VIN не найден — пустая строка, если число неизвестно — 0.

PRICE WATCH:
Ниже машины, которые мы уже видели. По возможности перепроверь, не изменилась ли у них цена и не перевыложены ли они:
${JSON.stringify(watchlist)}

Цель — высокая полнота сбора. Лучше 15 релевантных кандидатов для второго этапа, чем сразу выбрать одного и пропустить более выгодный.
`;

  return openaiJson({
    prompt,
    schema: discoverySchema,
    name: "car_candidate_discovery",
    effort: "low",
    maxOutputTokens: 16000,
  });
}

async function deepAnalyzeOne(candidate) {
  const prompt = `
Ты — DEEP ANALYSIS-этап Car Gem Scout. Ниже уже собранное реальное объявление. Теперь глубоко проверь ЭТОГО кандидата и верни структурированный анализ.

КАНДИДАТ:
${JSON.stringify(candidate)}

МОЙ ПРОФИЛЬ ПОКУПКИ:
- первая машина в Украине;
- максимум около $25,000;
- пробег желательно 60–70k км;
- хочу эффектную, дорогую на вид, спортивную/премиальную машину;
- 0–100 желательно ~6 сек или быстрее;
- важны надёжность, отсутствие системного денежного пылесоса, ликвидность в Украине и умеренная потеря цены через 1–2 года;
- главный ориентир Infiniti Q60;
- Stinger штрафуй за ликвидность, скучные массовые седаны не нужны.

ОБЯЗАТЕЛЬНАЯ ПРОВЕРКА США:
По VIN ищи Copart / IAAI / BidFax / Stat.vin / другие доступные архивы.
Проверь фото ДО ремонта, primary/secondary damage, Run & Drive / Starts, airbags, силовую структуру, flood/water, пробег, Estimated Repair Cost, ACV, Retail Value, Final Bid.
Не делай вывод "большой insurance estimate = труп" автоматически. Оцени реальный характер повреждения по фото и отношение estimate/ACV.

ЖЁСТКИЕ REJECT:
- flood/water;
- пожар;
- тяжёлый structural / rails / pillars / sills / floor / safety cell / geometry;
- тяжёлый фронт с высоким риском двигателя/турбин/охлаждения;
- множественный тяжёлый SRS;
- сомнительное восстановление или история, которую невозможно нормально подтвердить.
Если есть такой стоп-фактор — hard_reject=true.

REAL BUY-IN:
Оцени не только цену объявления, а реалистичную стоимость владения сразу после покупки:
цена + ожидаемое первичное ТО + резина/тормоза/жидкости/подвеска/мелкие ремонты, которые вероятны в первые ~6 месяцев.
Дай диапазон real_buy_in_low_usd / high.

SELLER / LISTING:
Отдельно оцени продавца/объявление: частник/площадка/перекуп, подозрительные формулировки и несостыковки VIN/год/привод/комплектация/пробег.

КОМПЛЕКТАЦИЯ:
Учитывай M Sport/AMG-style/пакеты, оптику, камеры, аудио, сиденья, диски, цвет салона и реально ликвидные опции. Бедная комплектация — минус.

SCORING 0–10:
- price_score — цена относительно реального рынка;
- history_score — история/повреждения/качество базы;
- technical_score — надёжность и риск крупных расходов;
- liquidity_score — ликвидность в Украине;
- emotion_score — внешний вид/динамика/вау-эффект;
- trim_score — комплектация.
Итоговый рейтинг код посчитает сам с весами 25/25/20/15/10/5.

CONFIDENCE:
confidence_pct — насколько полно подтверждены данные. Если нет VIN/аукционных фото/ключевой истории, уверенность должна заметно падать.

TARGET PRICE:
Даже если машина сейчас НЕ гем, дай target_buy_price_usd — цену, при которой при прочих равных она стала бы действительно интересной.

Не выдумывай отсутствующие значения. Для неизвестных чисел ставь 0, в строках пиши "нет данных".
candidate_key ОБЯЗАТЕЛЬНО скопируй ровно из входного кандидата.
`;

  const result = await openaiJson({
    prompt,
    schema: analysisSchema,
    name: "car_deep_analysis",
    effort: "medium",
    maxOutputTokens: 16000,
    background: true,
  });

  return (result.analyses || [])[0] || null;
}

async function deepAnalyzeCandidates(candidates, state) {
  if (!candidates.length) return { analyses: [] };

  const analyses = [];

  // One car per response and sequential execution keep us under API TPM limits.
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await deepAnalyzeOne(candidate);
      if (result) analyses.push(result);
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.error("Deep analysis failed for " + candidate.candidate_key + ": " + String(error?.message || error));
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (candidates.length > 0 && analyses.length === 0) {
    throw new Error("All selected deep analyses failed (" + failed + "/" + candidates.length + ")");
  }

  return { analyses, failed };
}

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const runStartedAt = new Date().toISOString();
const chatId = await getChatId();
const state = loadSeen();


if (TEST_ONLY) {
  state.last_test_at = runStartedAt;
  saveState(state);
  await sendText(chatId,
    "✅ Car Gem Scout подключён.\n\n" +
    "Режим: каждые 4 часа / 6 раз в сутки.\n" +
    "Проверяю AUTO.RIA + KIEVAVTO + IsAuto и пишу сюда только когда нахожу реальный ГЕМ.\n\n" +
    "Команды: /start или /status — текущий статус бота."
  );
  process.exit(0);
}

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

try {
  const discovery = await discoverCandidates(state);
  const nowIso = new Date().toISOString();
  const discovered = (discovery.candidates || [])
    .filter((x) => x && (x.source_url || x.auto_ria_url || x.telegram_url))
    .map((x) => recordDiscoveredCandidate(state, x, nowIso));

  state.last_discovered_count = discovered.length;

  const selected = discovered
    .filter((x) => {
      if (x.never_analyzed) return true;
      if (x.price_drop_trigger) return true;
      if (x.target_price_trigger) return true;
      return false;
    })
    .sort((a, b) => {
      const ap =
        (a.target_price_trigger ? 1000 : 0) +
        (a.price_drop_trigger ? 500 : 0) +
        (a.never_analyzed ? 100 : 0) +
        Number(a.discovery_score || 0);
      const bp =
        (b.target_price_trigger ? 1000 : 0) +
        (b.price_drop_trigger ? 500 : 0) +
        (b.never_analyzed ? 100 : 0) +
        Number(b.discovery_score || 0);
      return bp - ap;
    })
    .slice(0, 3);

  state.last_deep_analyzed_count = selected.length;
  saveState(state);

  const deep = await deepAnalyzeCandidates(selected, state);
  state.last_deep_failed_count = Number(deep.failed || 0);
  const analysisByKey = new Map((deep.analyses || []).map((a) => [a.candidate_key, a]));
  const watch = ensureMarketWatch(state);
  const alerts = [];

  for (const candidate of selected) {
    const a = analysisByKey.get(candidate.candidate_key);
    if (!a) continue;

    const score = weightedScore(a);
    const item = watch[candidate.candidate_key] || {};
    item.last_analyzed_at = nowIso;
    item.last_analyzed_price_usd = Number(a.price_usd || candidate.price_usd || 0);
    item.last_score = score;
    item.last_confidence_pct = Number(a.confidence_pct || 0);
    item.target_buy_price_usd = Number(a.target_buy_price_usd || 0);
    item.real_buy_in_low_usd = Number(a.real_buy_in_low_usd || 0);
    item.real_buy_in_high_usd = Number(a.real_buy_in_high_usd || 0);
    item.hard_reject = Boolean(a.hard_reject);
    item.hard_reject_reason = a.hard_reject_reason || "";
    watch[candidate.candidate_key] = item;

    const qualifies =
      !a.hard_reject &&
      score >= 8.5 &&
      Number(a.confidence_pct || 0) >= 70 &&
      Number(a.price_usd || candidate.price_usd || 0) <= 26000;

    const mayRepeat = candidate.price_drop_trigger || candidate.target_price_trigger;
    if (qualifies && (!item.alerted || mayRepeat)) {
      alerts.push({
        text: formatGemAlert(a, score, candidate),
        key: candidate.candidate_key,
        score,
        price_usd: Number(a.price_usd || candidate.price_usd || 0),
      });
    }
  }

  state.last_check_at = runStartedAt;
  state.completed_runs = Number(state.completed_runs || 0) + 1;
  state.last_error = null;

  if (!alerts.length) {
    state.last_check_status = "no_gem";
    state.last_found_count = 0;
    state.last_sent_count = 0;
    saveState(state);
    console.log(`Discovery: ${discovered.length}; deep analyzed: ${selected.length}; no qualifying gem. Telegram stays silent.`);
    process.exit(0);
  }

  state.last_check_status = "found";
  state.last_found_count = alerts.length;
  state.last_sent_count = 0;

  if (alerts.length > 1) {
    await sendText(chatId, `🔥 За этот проход найдено ${alerts.length} ГЕМОВ. Отправляю каждый отдельным сообщением.`);
  }

  for (const alert of alerts.slice(0, 5)) {
    await sendText(chatId, alert.text);
    state.last_sent_count += 1;
    state.total_gems_sent = Number(state.total_gems_sent || 0) + 1;

    const item = watch[alert.key] || {};
    item.alerted = true;
    item.alerted_at = nowIso;
    item.alerted_price_usd = alert.price_usd;
    item.alerted_score = alert.score;
    watch[alert.key] = item;

    saveSeen(state, alert.text);
  }

  saveState(state);
  console.log(`${state.last_sent_count} gem(s) sent to Telegram. Discovery: ${discovered.length}; deep analyzed: ${selected.length}.`);

} catch (error) {
  state.last_check_at = runStartedAt;
  state.last_check_status = "error";
  state.last_error = String(error?.message || error).slice(0, 500);
  state.completed_runs = Number(state.completed_runs || 0) + 1;
  saveState(state);
  throw error;
}
