const TelegramBotModule = require("node-telegram-bot-api");
const TelegramBot = TelegramBotModule.default || TelegramBotModule.TelegramBot || TelegramBotModule;
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL || "https://tonix-bz8b.onrender.com";

const DEVELOPER_ID = "7795559285";
const START_BALANCE = 500.00;
const USERS_FILE = path.join(__dirname, "users.json");

if (!TOKEN) {
  console.error("BOT_TOKEN غير موجود ❌");
  process.exit(1);
}

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, "{}");
    }

    const data = fs.readFileSync(USERS_FILE, "utf8").trim();
    return data ? JSON.parse(data) : {};
  } catch (error) {
    console.error("USERS LOAD ERROR:", error);
    return {};
  }
}

function saveUsers(users) {
  const tempFile = USERS_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(users, null, 2));
  fs.renameSync(tempFile, USERS_FILE);
}

function getOrCreateUser(telegramUser) {
  const users = loadUsers();
  const id = String(telegramUser.id);

  if (!users[id]) {
    users[id] = {
      telegram_id: telegramUser.id,
      username: telegramUser.username || "",
      first_name: telegramUser.first_name || "",
      last_name: telegramUser.last_name || "",
      balance: START_BALANCE,
      referrals: [],
      total_referrals: 0,
      referral_earned: 0,
      free_gift_last_claim: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    saveUsers(users);
    return { user: users[id], isNew: true };
  }

  // تحديث معلومات الحساب فقط، بدون إعادة الـ500 TON
  users[id].username = telegramUser.username || users[id].username || "";
  users[id].first_name = telegramUser.first_name || users[id].first_name || "";
  users[id].last_name = telegramUser.last_name || users[id].last_name || "";
  users[id].updated_at = new Date().toISOString();

  saveUsers(users);

  return { user: users[id], isNew: false };
}

function isDeveloper(userId) {
  return String(userId) === DEVELOPER_ID;
}

function formatBalance(balance) {
  return Number(balance).toFixed(2);
}

const bot = new TelegramBot(TOKEN, { polling: true });

bot.onText(/^\/start(?:\s+.*)?$/, async (msg) => {
  const ctx = { from: msg.from, reply: (text, opts) => bot.sendMessage(msg.chat.id, text, opts), message: msg };
  try {
    const startArg = String(msg.text || "").trim().split(/\s+/)[1] || "";
    const referrerId = startArg.startsWith("ref_") ? startArg.slice(4) : "";
    const usersBefore = loadUsers();
    const { user, isNew } = getOrCreateUser(ctx.from);
    const users = loadUsers();
    if (isNew && referrerId && referrerId !== String(ctx.from.id) && users[referrerId]) {
      users[referrerId].referrals = Array.isArray(users[referrerId].referrals) ? users[referrerId].referrals : [];
      users[referrerId].total_referrals = Number(users[referrerId].total_referrals || users[referrerId].referrals.length);
      users[referrerId].referral_earned = Number(users[referrerId].referral_earned || 0);
      if (!users[referrerId].referrals.includes(String(ctx.from.id))) {
        users[referrerId].referrals.push(String(ctx.from.id));
        users[referrerId].total_referrals = users[referrerId].referrals.length;
        users[referrerId].referral_earned += 50;
        users[referrerId].balance = Number(users[referrerId].balance || 0) + 50;
        users[String(ctx.from.id)].referred_by = referrerId;
        saveUsers(users);
      }
    }

    const keyboard = {
      inline_keyboard: [[{
        text: "🚀 Open TONIX",
        web_app: { url: MINI_APP_URL }
      }]]
    };
    const board = {
      keyboard: [[{ text: "🚀 فتح TONIX" }, { text: "💰 الرصيد" }], [{ text: "👤 حسابي" }]],
      resize_keyboard: true,
      is_persistent: true
    };

    const welcome = isNew
      ? `🚀 أهلاً بك في TONIX`
      : `🚀 أهلاً بك مجددًا في TONIX`;

    await ctx.reply(
      `${welcome}\n\nلوحة البداية جاهزة، اضغط لفتح TONIX:`,
      { reply_markup: keyboard }
    );
    await ctx.reply("اختر من اللوحة أو افتح TONIX من الزر أعلاه.", { reply_markup: board });
  } catch (error) {
    console.error("START ERROR:", error);
  }
});

// عرض الحساب
bot.onText(/^\/balance$/, async (msg) => {
  const ctx = { from: msg.from, reply: (text, opts) => bot.sendMessage(msg.chat.id, text, opts), message: msg };
  try {
    const { user } = getOrCreateUser(ctx.from);

    await ctx.reply(
      `👤 ${user.first_name || "Player"}\n` +
      `🆔 ID: ${user.telegram_id}\n` +
      `🔗 Username: @${user.username || "none"}\n` +
      `💎 الرصيد: ${formatBalance(user.balance)} TON`
    );
  } catch (error) {
    console.error("BALANCE ERROR:", error);
  }
});

// أمر للمطور فقط:
// /setbalance TELEGRAM_ID AMOUNT
bot.onText(/^\/setbalance(?:\s+.*)?$/, async (msg) => {
  const ctx = { from: msg.from, reply: (text, opts) => bot.sendMessage(msg.chat.id, text, opts), message: msg };
  try {
    if (!isDeveloper(ctx.from.id)) {
      return ctx.reply("❌ هذا الأمر خاص بالمطور فقط.");
    }

    const parts = ctx.message.text.trim().split(/\s+/);

    if (parts.length !== 3) {
      return ctx.reply(
        "الاستخدام الصحيح:\n/setbalance TELEGRAM_ID AMOUNT"
      );
    }

    const targetId = String(parts[1]);
    const newBalance = Number(parts[2]);

    if (!/^\d+$/.test(targetId)) {
      return ctx.reply("❌ Telegram ID غير صحيح.");
    }

    if (!Number.isFinite(newBalance) || newBalance < 0) {
      return ctx.reply("❌ قيمة الرصيد غير صحيحة.");
    }

    const users = loadUsers();

    if (!users[targetId]) {
      return ctx.reply("❌ هذا اللاعب غير مسجل في البوت.");
    }

    const oldBalance = Number(users[targetId].balance);
    users[targetId].balance = Number(newBalance.toFixed(2));
    users[targetId].updated_at = new Date().toISOString();

    saveUsers(users);

    await ctx.reply(
      `✅ تم تعديل الرصيد.\n\n` +
      `🆔 ${targetId}\n` +
      `💎 القديم: ${formatBalance(oldBalance)} TON\n` +
      `💎 الجديد: ${formatBalance(newBalance)} TON`
    );
  } catch (error) {
    console.error("SETBALANCE ERROR:", error);
    await ctx.reply("❌ حدث خطأ أثناء تعديل الرصيد.");
  }
});

// قائمة المطور
bot.onText(/^\/admin$/, async (msg) => {
  const ctx = { from: msg.from, reply: (text, opts) => bot.sendMessage(msg.chat.id, text, opts), message: msg };
  if (!isDeveloper(ctx.from.id)) {
    return ctx.reply("❌ هذا الأمر خاص بالمطور فقط.");
  }

  await ctx.reply(
    "🛠 أوامر المطور:\n\n" +
    "/setbalance ID AMOUNT\n" +
    "تعديل رصيد لاعب.\n\n" +
    "/users\n" +
    "عرض عدد اللاعبين المسجلين."
  );
});

// عدد اللاعبين للمطور فقط
bot.onText(/^\/users$/, async (msg) => {
  const ctx = { from: msg.from, reply: (text, opts) => bot.sendMessage(msg.chat.id, text, opts), message: msg };
  if (!isDeveloper(ctx.from.id)) {
    return ctx.reply("❌ هذا الأمر خاص بالمطور فقط.");
  }

  const users = loadUsers();
  const count = Object.keys(users).length;

  await ctx.reply(`👥 عدد اللاعبين المسجلين: ${count}`);
});

bot.onText(/^🚀 فتح TONIX$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "🚀 افتح TONIX من الزر التالي:", { reply_markup: { inline_keyboard: [[{ text: "🚀 Open TONIX", web_app: { url: MINI_APP_URL } }]] } });
});
bot.onText(/^💰 الرصيد$/, async (msg) => {
  const { user } = getOrCreateUser(msg.from);
  await bot.sendMessage(msg.chat.id, `💎 رصيدك: ${formatBalance(user.balance)} TON`);
});
bot.onText(/^👤 حسابي$/, async (msg) => {
  const { user } = getOrCreateUser(msg.from);
  await bot.sendMessage(msg.chat.id, `👤 ${user.first_name || "Player"}\n🆔 ID: ${user.telegram_id}\n🔗 @${user.username || "none"}`);
});

// Register the visible Telegram command menu.
bot.setMyCommands([
  { command: "start", description: "فتح TONIX" },
  { command: "balance", description: "عرض الرصيد" },
  { command: "admin", description: "لوحة المطور" }
]).catch(error => console.error("SET COMMANDS ERROR:", error.message || error));

bot.on("polling_error", (error) => {
  const message = error && (error.message || error.toString()) || "Unknown polling error";
  console.error("BOT POLLING ERROR:", message);
  // node-telegram-bot-api normally retries polling by itself.
  // Keep the process alive for transient Telegram/network failures such as ECONNRESET.
});

function isTransientNetworkError(error) {
  const message = String(error && (error.message || error.code || error) || "").toUpperCase();
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EFATAL|SOCKET HANG UP|NETWORK/.test(message);
}

process.on("unhandledRejection", (reason) => {
  if (isTransientNetworkError(reason)) {
    console.error("BOT NETWORK ERROR (kept alive):", reason && (reason.message || reason));
    return;
  }
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (error) => {
  if (isTransientNetworkError(error)) {
    console.error("BOT NETWORK EXCEPTION (kept alive):", error.message || error);
    return;
  }
  console.error("UNCAUGHT EXCEPTION:", error);
});

console.log("TONIX Telegram Bot is running ✅");
console.log("User database: " + USERS_FILE);
console.log("Developer ID: " + DEVELOPER_ID);
