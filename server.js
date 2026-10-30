const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const orders = new Map();
let telegramOffset = 0;
let telegramRunning = false;

function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID);
}

async function telegram(method, body) {
  if (!telegramConfigured()) return null;
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify(body)
  });
  return response.json();
}

async function notify(text, buttons = null) {
  const body = {
    chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
    text,
    parse_mode: "HTML"
  };
  if (buttons) body.reply_markup = {inline_keyboard: buttons};
  return telegram("sendMessage", body);
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
}

function normalizeZimbabwePhone(phone) {
  const p = String(phone || "").trim().replace(/[^\d+]/g, "");
  if (/^07\d{8}$/.test(p)) return "+263" + p.slice(1);
  if (/^7\d{8}$/.test(p)) return "+263" + p;
  if (/^\+2637\d{8}$/.test(p)) return p;
  if (/^2637\d{8}$/.test(p)) return "+" + p;
  return null;
}

async function startTelegramPolling() {
  if (!telegramConfigured() || telegramRunning) return;
  telegramRunning = true;

  try {
    const me = await telegram("getMe", {});
    if (!me || !me.ok) {
      console.log("Telegram bot configuration could not be verified.");
      telegramRunning = false;
      return;
    }
    console.log(`Telegram bot connected: @${me.result.username}`);

    while (telegramRunning) {
      try {
        const result = await telegram("getUpdates", {
          offset: telegramOffset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"]
        });

        if (!result || !result.ok) {
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }

        for (const update of result.result) {
          telegramOffset = update.update_id + 1;

          if (update.callback_query) {
            await handleCallback(update.callback_query);
          } else if (update.message) {
            await handleMessage(update.message);
          }
        }
      } catch (err) {
        console.error("Telegram polling error:", err.message);
        await new Promise(r => setTimeout(r, 4000));
      }
    }
  } catch (err) {
    console.error("Telegram startup error:", err.message);
    telegramRunning = false;
  }
}

function isAdminChat(chatId) {
  return String(chatId) === String(process.env.TELEGRAM_ADMIN_CHAT_ID);
}

async function handleMessage(message) {
  if (!isAdminChat(message.chat.id)) return;
  const text = (message.text || "").trim();

  if (text === "/start" || text === "/help") {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "ZimBundles admin bot is active.\\n\\n/orders — show recent orders\\n/status — bot status"
    });
  } else if (text === "/status") {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: `🟢 ZimBundles bot active\\nOrders in memory: ${orders.size}`
    });
  } else if (text === "/orders") {
    const recent = Array.from(orders.values()).slice(-10).reverse();
    if (!recent.length) {
      await telegram("sendMessage", {chat_id: message.chat.id, text:"No orders yet."});
      return;
    }
    for (const o of recent) {
      await sendOrderCard(o);
    }
  }
}

async function sendOrderCard(order) {
  const text =
`🛒 <b>ZimBundles order</b>
<b>ID:</b> ${order.id}
<b>Type:</b> ${order.type}
<b>Bundle:</b> ${order.bundle}
<b>Price:</b> ${order.price}
<b>Phone:</b> ${order.phone}
<b>Status:</b> ${order.status}`;

  const buttons = [[
    {text:"✅ Approve", callback_data:`approve:${order.id}`},
    {text:"❌ Reject", callback_data:`reject:${order.id}`}
  ]];

  await notify(text, buttons);
}

async function handleCallback(query) {
  if (!isAdminChat(query.message.chat.id)) return;

  const [action, id] = String(query.data || "").split(":");
  const order = orders.get(id);

  if (!order) {
    await telegram("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Order not found."
    });
    return;
  }

  if (action === "approve") order.status = "approved";
  else if (action === "reject") order.status = "rejected";
  else return;

  await telegram("answerCallbackQuery", {
    callback_query_id: query.id,
    text: `Order ${order.status}.`
  });

  await telegram("editMessageReplyMarkup", {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    reply_markup: {inline_keyboard: [[{text:`Status: ${order.status.toUpperCase()}`, callback_data:"noop"}]]}
  });

  await notify(`📢 Order <b>${order.id}</b> is now <b>${order.status.toUpperCase()}</b>.`);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "zimbundles",
    telegram: telegramConfigured() ? "configured" : "not_configured",
    payment: "EcoCash integration pending"
  });
});

app.post("/api/orders", async (req, res) => {
  const {bundle, price, phone, type = "bundle"} = req.body;
  const normalizedPhone = normalizeZimbabwePhone(phone);
  const numericPrice = Number(price);

  if (!bundle || !Number.isFinite(numericPrice) || numericPrice < 0 || !normalizedPhone) {
    return res.status(400).json({ok:false, error:"Valid bundle, price and Zimbabwe phone number are required."});
  }

  const order = {
    id: makeId(type === "trial" ? "TRIAL" : "ORDER"),
    type,
    bundle,
    price: numericPrice,
    phone: normalizedPhone,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  orders.set(order.id, order);

  if (telegramConfigured()) {
    await sendOrderCard(order);
  }

  res.status(201).json({
    ok: true,
    orderId: order.id,
    status: order.status,
    message: telegramConfigured()
      ? "Request sent for admin review."
      : "Order created. Configure Telegram on Render for admin notifications."
  });
});

app.get("/api/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ok:false, error:"Order not found"});
  res.json({ok:true, order});
});

app.get("/api/telegram-test", async (req, res) => {
  if (!telegramConfigured()) {
    return res.status(400).json({ok:false, error:"Set TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID on Render."});
  }
  const result = await notify("🟢 <b>ZimBundles test notification</b> — Telegram is connected.");
  res.json(result);
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`ZimBundles running on port ${PORT}`);
  startTelegramPolling();
});