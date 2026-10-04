export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (req.method !== "POST") return res.status(200).json({ok:true});
  const message = req.body?.message;
  if (!message?.chat?.id || !token) return res.status(200).json({ok:true});
  const chatId = String(message.chat.id);
  const text = (message.text || "").trim();
  if (text === "/start" || text.startsWith("/start ")) {
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        chat_id: chatId,
        text: "🔥 Car Gem Scout подключён.\n\nТвой chat_id: " + chatId + "\n\nПришли этот номер в ChatGPT — я привяжу сюда алерты."
      })
    });
  }
  return res.status(200).json({ok:true});
}
