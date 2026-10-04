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

async function research(seen) {
  const prompt = `
Ты — мой персональный Car Gem Scout. Подбираешь мне ПЕРВУЮ машину в Украине.
Тебе нельзя присылать просто хорошие или интересные варианты. Нужны ТОЛЬКО реальные ГЕМЫ, которые после глубокого ресерча выглядят как сильная покупка.

ИСТОЧНИКИ, которые надо обязательно проверить:
1. AUTO.RIA — свежие объявления по Украине.
2. KIEVAVTO — https://t.me/kievavto2 и публичная веб-лента https://t.me/s/kievavto2
3. IsAuto — https://t.me/isAuto99 и публичные/индексированные посты канала.
После нахождения кандидата обязательно делай отдельный поиск по VIN в Copart, IAAI, BidFax, Stat.vin и других доступных архивах аукционов.

МОИ КРИТЕРИИ:
- бюджет до $25,000;
- пробег желательно до 60–70 тыс. км;
- машина должна выглядеть очень эффектно, дорого, спортивно/премиально, не как обычный массовый седан;
- хочется реально кайфовать от первой машины;
- динамика желательно около 6 секунд 0–100 или быстрее; немного медленнее допустимо только если машина сама по себе исключительная;
- модель не должна иметь репутацию постоянно проблемной и пожирающей большие деньги на СТО;
- важна ликвидность в Украине;
- желательно небольшой риск потери стоимости через 1–2 года;
- главный ориентир — Infiniti Q60;
- также подходят спортивные BMW/купе, Mercedes coupe/CLA/C-Class в хороших комплектациях, Lexus RC/IS, Audi и другие реально подходящие модели;
- не предлагай Honda Accord и прочие скучные массовые седаны;
- Kia Stinger обычно не предлагай из-за ликвидности, кроме совсем исключительной сделки.

АМЕРИКАНСКАЯ ИСТОРИЯ:
Машина из США допустима и даже ожидаема, но история должна быть ХОРОШЕЙ ДЛЯ ПОКУПКИ.
Автоматически отбрасывай:
- flood/water;
- пожар;
- тяжелый total;
- сильные повреждения лонжеронов, стоек, порогов, пола, силовой клетки или геометрии;
- тяжелый фронт с высоким риском двигателя/турбин/охлаждения;
- множественные сработавшие airbags / тяжелый SRS;
- машины, где невозможно нормально понять исходное повреждение или восстановление выглядит сомнительно.

Умеренные кузовные/косметические повреждения допустимы, если силовая структура по фото выглядит целой, SRS адекватный, пробег последовательный и цена реально компенсирует историю.

ПО КАЖДОМУ КАНДИДАТУ НУЖНО НАЙТИ:
- VIN;
- Copart или IAAI, lot и дату;
- primary/secondary damage;
- Run & Drive / Starts;
- airbags;
- состояние силовой структуры;
- flood/water;
- пробег на аукционе и последовательность пробега;
- что видно на фото ДО ремонта;
- Estimated Repair Cost / страховую оценку стоимости ремонта;
- ACV / Actual Cash Value;
- Retail Value, если есть;
- Final Bid / Sale Price, если есть;
- Estimated Repair Cost как процент от ACV;
- типичные проблемы именно модели/двигателя;
- что обязательно проверить на диагностике;
- актуальную цену сопоставимых машин в Украине;
- прогноз цены перепродажи через 1–2 года;
- ликвидность.

ВАЖНО ПРО СТРАХОВУЮ:
Не делай вывод "дорогой estimate = машина убита" автоматически. Американская страховая оценка может быть огромной из-за официальных цен деталей/работы. Смотри прежде всего на фото и характер повреждений. Но всегда показывай мне сам estimate, ACV и отношение estimate/ACV, чтобы я видел масштаб.

ЖЕСТКИЙ ФИЛЬТР:
Присылай машину только если итогово она заслуживает минимум 8.5/10 и ты сам после проверки считаешь ее реально хорошей покупкой.
Лучше НИЧЕГО не прислать, чем прислать посредственный вариант.
Максимум 1–5 машин за запуск; предпочтительно 1–3 лучших ГЕМА. Не добивай количество искусственно.

УЖЕ ПРИСЫЛАЛИ РАНЬШЕ — НЕ ПОВТОРЯЙ:
VIN: ${(seen.vins || []).join(", ") || "нет"}
URL: ${(seen.urls || []).slice(-100).join("\n") || "нет"}

КРИТИЧНО: В ОТВЕТЕ ДОЛЖНЫ БЫТЬ ПРЯМЫЕ ССЫЛКИ.
Если нашел на AUTO.RIA — дай полный URL конкретного объявления.
Если нашел в Telegram — дай полный URL конкретного поста.
Если та же машина есть и там, и там — дай ОБЕ ссылки.
Также дай прямой URL на страницу лота/архива Copart/IAAI/BidFax/Stat.vin, где можно увидеть историю или фото до ремонта.
Не пиши просто "AUTO.RIA" или "Copart" без ссылки.

ЕСЛИ НЕТ НИ ОДНОГО НАСТОЯЩЕГО ГЕМА:
верни РОВНО одно слово:
NO_GEM

ЕСЛИ ГЕМ ЕСТЬ — ФОРМАТ:

🔥 ГЕМ / СМОТРЕТЬ СРОЧНО — [модель, год, комплектация]

💵 Цена: $...
🛣 Пробег: ... км
⚙️ Двигатель / коробка / привод: ...
🏁 0–100: ~... с
⭐ Рейтинг покупки: X/10

🔗 ГДЕ НАШЁЛ
AUTO.RIA: https://...  (или "нет", если источником был Telegram)
Telegram: https://...  (или "нет")
История США / лот / фото до ремонта: https://...

💎 ПОЧЕМУ ЭТО ГЕМ
— 2–4 самых сильных аргумента без воды

🇺🇸 ИСТОРИЯ США
VIN: ...
Аукцион / lot / дата: ...
Primary / Secondary Damage: ...
Run & Drive / Starts: ...
Airbags: ...
Силовая структура: ...
Flood/Water: ...
Пробег на аукционе: ...
Фото до ремонта: кратко, что реально видно
Estimated Repair Cost / страховая оценка: $...
ACV: $...
Retail Value: $... / нет данных
Final Bid / Sale Price: $... / нет данных
Repair Estimate / ACV: ...%

🔧 ТЕХНИКА
Типичные слабые места: ...
Что проверить перед покупкой: ...
Риск крупных расходов: низкий / средний / высокий

💰 ДЕНЬГИ
Рынок аналогов в Украине: $...–$...
Насколько выгодно предложение: ...
Ориентир перепродажи через 1–2 года: $...
Ожидаемая потеря: ...
Ликвидность: X/10

🏁 ВЕРДИКТ
Одно конкретное резюме: стал бы ты сам звонить продавцу и ехать смотреть эту машину первой или нет, и почему.

Не выдумывай данные. Если цифры Estimated Repair Cost, ACV, Final Bid и т.п. реально не найдены — пиши "нет данных".
`;

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-6.1-sol",
      reasoning: { effort: "high" },
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
      max_output_tokens: 6000,
      store: false,
    }),
  });

  const raw = await r.text();
  if (!r.ok) throw new Error(`OpenAI API failed ${r.status}: ${raw.slice(0, 1000)}`);
  const data = JSON.parse(raw);
  return (data.output || [])
    .filter((x) => x.type === "message")
    .flatMap((x) => x.content || [])
    .filter((x) => x.type === "output_text")
    .map((x) => x.text || "")
    .join("\n")
    .trim();
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
  const result = await research(state);

  state.last_check_at = runStartedAt;
  state.completed_runs = Number(state.completed_runs || 0) + 1;
  state.last_error = null;

  if (!result || result === "NO_GEM" || result.includes("NO_GEM")) {
    state.last_check_status = "no_gem";
    state.last_found_count = 0;
    state.last_sent_count = 0;
    saveState(state);
    console.log("No gem found. Telegram stays silent.");
    process.exit(0);
  }

  const gems = splitGems(result).slice(0, 5);
  state.last_check_status = "found";
  state.last_found_count = gems.length;
  state.last_sent_count = 0;

  if (gems.length > 1) {
    await sendText(chatId, `🔥 За этот проход найдено ${gems.length} ГЕМОВ. Отправляю каждый отдельным сообщением.`);
  }

  for (const gem of gems) {
    await sendText(chatId, gem);
    state.last_sent_count += 1;
    state.total_gems_sent = Number(state.total_gems_sent || 0) + 1;
    saveSeen(state, gem);
  }

  saveState(state);
  console.log(`${gems.length} gem(s) sent to Telegram.`);
} catch (error) {
  state.last_check_at = runStartedAt;
  state.last_check_status = "error";
  state.last_error = String(error?.message || error).slice(0, 500);
  state.completed_runs = Number(state.completed_runs || 0) + 1;
  saveState(state);
  throw error;
}
