/**
 * mock-game.js
 * Demo Rocket backend
 *
 * Virtual credits only.
 * No TON / wallets / deposits / withdrawals.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = 8765;

const clients = new Set();
const players = new Map();
const balances = new Map();

let roundKey = "";
let phase = "countdown";
let countdown = 5;
let multiplier = 1;
let crashPoint = 2.8;
let startTime = 0;
let crashHistory = [];

const DEMO_STARTING_CREDITS = 500;
const REFERRAL_REWARD = 50;
const FREE_GIFT_COOLDOWN_MS = 8 * 60 * 60 * 1000;
const FREE_GIFT_AMOUNTS = [10, 20, 35, 50, 75, 100, 250, 350, 500];
const PVP_ROUND_MS = 15 * 1000;
let pvpRound = null;
let pvpHistory = [];
const activityLog = [];

function logActivity(type, message, meta = {}) {
  activityLog.unshift({ type, message, ...meta, at: new Date().toISOString() });
  if (activityLog.length > 200) activityLog.length = 200;
}

function ensureUser(users, id, data = {}) {
  const key = String(id);
  if (!users[key]) {
    users[key] = {
      telegram_id: Number(key), username: data.username || '', first_name: data.first_name || 'Player', last_name: data.last_name || '',
      photo_url: data.photo_url || '', balance: DEMO_STARTING_CREDITS, referrals: [], total_referrals: 0, referral_earned: 0,
      free_gift_last_claim: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
  }
  normalizeUserRecord(users[key], key);
  return users[key];
}

function isDeveloperId(id) { return String(id) === '7795559285'; }

function settlePvpRound() {
  if (!pvpRound || pvpRound.status !== 'open') return;
  const entries = [...pvpRound.participants.values()];
  if (!entries.length) { pvpRound.status = 'finished'; pvpRound.winnerId = null; return; }
  const winner = entries[Math.floor(Math.random() * entries.length)];
  const pot = Number(entries.reduce((sum, p) => sum + p.amount, 0).toFixed(2));
  const users = loadUsers();
  const winnerUser = ensureUser(users, winner.id);
  winnerUser.balance = Number((Number(winnerUser.balance || 0) + pot).toFixed(2));
  winnerUser.updated_at = new Date().toISOString();
  winnerUser.pvp_wins = Number(winnerUser.pvp_wins || 0) + 1;
  winnerUser.pvp_earnings = Number((Number(winnerUser.pvp_earnings || 0) + pot - winner.amount).toFixed(2));
  for (const p of entries) {
    const u = ensureUser(users, p.id);
    u.pvp_games = Number(u.pvp_games || 0) + 1;
    if (p.id !== winner.id) u.pvp_losses = Number(u.pvp_losses || 0) + 1;
    u.updated_at = new Date().toISOString();
  }
  saveUsers(users);
  balances.set(String(winner.id), Number(winnerUser.balance));
  pvpRound.status = 'finished';
  pvpRound.winnerId = String(winner.id);
  pvpRound.winnerName = winner.name;
  pvpRound.pot = pot;
  pvpRound.finishedAt = Date.now();
  pvpHistory.unshift({ id: pvpRound.id, pot, winnerId: String(winner.id), winnerName: winner.name, players: entries.length, finishedAt: pvpRound.finishedAt });
  pvpHistory = pvpHistory.slice(0, 30);
  logActivity('pvp', `PVP round ${pvpRound.id} finished`, { winnerId: String(winner.id), pot, players: entries.length });
}

function schedulePvpSettlement() {
  if (!pvpRound) return;
  const delay = Math.max(0, pvpRound.endsAt - Date.now());
  setTimeout(() => { if (pvpRound && pvpRound.status === 'open' && Date.now() >= pvpRound.endsAt) settlePvpRound(); }, delay + 10);
}

/* =========================================================
   HTTP SERVER
   This fixes Abasthān / Cloudflare 502.
   ========================================================= */

const server = http.createServer((req, res) => {
  try {
    let requestPath = req.url || "/";

    // Remove query string
    requestPath = requestPath.split("?")[0];

    // WebSocket endpoint is handled by ws server below
    if (requestPath === "/ws/ton-rocket") {
      res.writeHead(426, {
        "Content-Type": "text/plain; charset=utf-8"
      });

      res.end("WebSocket endpoint");
      return;
    }

    // Security: prevent path traversal
    let cleanPath = decodeURIComponent(requestPath);

    if (cleanPath === "/") {
      cleanPath = "/index.html";
    }

    if (cleanPath.includes("..")) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const filePath = path.join(
      process.cwd(),
      cleanPath.replace(/^\/+/, "")
    );

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });

      res.end("Not Found");
      return;
    }

    const stat = fs.statSync(filePath);

    if (!stat.isFile()) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();

    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
      ".txt": "text/plain; charset=utf-8",
      ".woff": "font/woff",
      ".woff2": "font/woff2"
    };

    res.writeHead(200, {
      "Content-Type":
        contentTypes[ext] ||
        "application/octet-stream",

      "Cache-Control":
        ext === ".html"
          ? "no-cache"
          : "public, max-age=3600"
    });

    fs.createReadStream(filePath).pipe(res);

  } catch (error) {
    console.error("HTTP error:", error);

    if (!res.headersSent) {
      res.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8"
      });
    }

    res.end("Internal Server Error");
  }
});

/* =========================================================
   HTTP API (used by the Mini App)
   ========================================================= */

function saveUsers(users) {
  try {
    fs.writeFileSync(
      path.join(process.cwd(), "users.json"),
      JSON.stringify(users, null, 2)
    );
  } catch (error) {
    console.error("Could not save users.json:", error.message);
  }
}

function userIdFromRequest(req, body = {}) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const direct = url.searchParams.get("chatId") || url.searchParams.get("userId") || body.chatId;
  if (direct) return String(direct);

  const raw = req.headers["x-telegram-init-data"] || req.headers["x-telegram-init-data"];
  if (raw) {
    try {
      const params = new URLSearchParams(String(raw));
      const user = JSON.parse(params.get("user") || "null");
      if (user?.id) return String(user.id);
    } catch {}
  }
  return "";
}

function apiJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, callback) {
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    try { callback(JSON.parse(body || "{}")); }
    catch { callback({}); }
  });
}


function normalizeUserRecord(user, id) {
  if (!user) return user;
  if (!Array.isArray(user.referrals)) user.referrals = [];
  if (!Number.isFinite(Number(user.total_referrals))) user.total_referrals = user.referrals.length;
  if (!Number.isFinite(Number(user.referral_earned))) user.referral_earned = 0;
  if (!Number.isFinite(Number(user.free_gift_last_claim))) user.free_gift_last_claim = 0;
  if (typeof user.photo_url !== "string") user.photo_url = "";
  if (!Array.isArray(user.referrals)) user.referrals = [];
  return user;
}

function getUser(users, id) {
  if (!users[id]) return null;
  return normalizeUserRecord(users[id], id);
}

function resolveRecipient(users, input) {
  const value = String(input || '').trim().replace(/^@/, '');
  if (/^\d+$/.test(value) && users[value]) return value;
  const wanted = value.toLowerCase();
  const found = Object.values(users).find(u => String(u.username || '').toLowerCase() === wanted);
  return found ? String(found.telegram_id) : '';
}

function freeGiftStatus(user) {
  const last = Number(user?.free_gift_last_claim || 0);
  const nowMs = Date.now();
  const ready = !last || nowMs - last >= FREE_GIFT_COOLDOWN_MS;
  return { ready, nextClaimAt: ready ? nowMs : last + FREE_GIFT_COOLDOWN_MS, remainingMs: ready ? 0 : last + FREE_GIFT_COOLDOWN_MS - nowMs };
}

const originalHttpHandler = server.listeners("request")[0];
server.removeAllListeners("request");
server.on("request", (req, res) => {
  const requestPath = (req.url || "/").split("?")[0];

  if (requestPath === "/api/online-count" && req.method === "GET") {
    return apiJson(res, 200, { count: clients.size });
  }

  if (requestPath === "/api/stats" && req.method === "GET") {
    return apiJson(res, 200, {
      count: clients.size,
      onlineCount: clients.size,
      playersTotal: players.size,
      phase,
      multiplier,
      crashHistory: [...crashHistory]
    });
  }

  if (requestPath === "/api/admin/check-access" && req.method === "GET") {
    const id = userIdFromRequest(req);
    return apiJson(res, 200, { isDeveloper: id === "7795559285" });
  }

  if (requestPath === "/api/admin/is-banned" && req.method === "GET") {
    return apiJson(res, 200, { isBanned: false, banned: false });
  }

  if (requestPath === "/api/wallet/balance" && req.method === "GET") {
    const id = userIdFromRequest(req);
    return apiJson(res, 200, {
      availableTON: id ? balance(id) : 500,
      balanceTON: id ? balance(id) : 500,
      lockedTON: 0,
      starsBalance: 0,
      lockedStarsBalance: 0
    });
  }

  const balancePath = requestPath.match(/^\/api\/wallet\/balance\/(\d+)$/);
  if (balancePath && req.method === "GET") {
    const id = balancePath[1];
    return apiJson(res, 200, {
      availableTON: balance(id),
      balanceTON: balance(id),
      lockedTON: 0
    });
  }

  if (requestPath === "/api/user/init" && req.method === "POST") {
    return readJsonBody(req, body => {
      const id = String(body.id || "");
      if (!id) return apiJson(res, 400, { success: false, error: "Telegram ID missing" });
      const users = loadUsers();
      let isNew = false;
      if (!users[id]) {
        users[id] = {
          telegram_id: Number(id),
          username: body.username || "",
          first_name: body.first_name || "Player",
          last_name: body.last_name || "",
          photo_url: body.photo_url || "",
          balance: DEMO_STARTING_CREDITS,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          referrals: [],
          total_referrals: 0,
          referral_earned: 0,
          free_gift_last_claim: 0,
          pvp_games: 0, pvp_wins: 0, pvp_losses: 0, pvp_earnings: 0,
          photo_url: body.photo_url || ""
        };
        isNew = true;
      }
      normalizeUserRecord(users[id], id);
      users[id].username = body.username || users[id].username || "";
      users[id].first_name = body.first_name || users[id].first_name || "Player";
      users[id].last_name = body.last_name || users[id].last_name || "";
      users[id].photo_url = body.photo_url || users[id].photo_url || "";
      if (isNew && !Number.isFinite(Number(users[id].balance))) users[id].balance = DEMO_STARTING_CREDITS;
      users[id].updated_at = new Date().toISOString();

      // A referral is applied once, only when the invited player is first registered.
      const referrerId = String(body.referrerId || "").replace(/^ref_/, "");
      if (isNew && referrerId && referrerId !== id && users[referrerId]) {
        normalizeUserRecord(users[referrerId], referrerId);
        if (!users[referrerId].referrals.includes(id)) {
          users[referrerId].referrals.push(id);
          users[referrerId].total_referrals = users[referrerId].referrals.length;
          users[referrerId].referral_earned = Number(users[referrerId].referral_earned || 0) + REFERRAL_REWARD;
          users[referrerId].balance = Number(users[referrerId].balance || 0) + REFERRAL_REWARD;
          users[id].referred_by = referrerId;
        }
      }
      saveUsers(users);
      if (!balances.has(id)) balances.set(id, Number(users[id].balance) || DEMO_STARTING_CREDITS);
      if (referrerId && users[referrerId] && balances.has(referrerId)) balances.set(referrerId, Number(users[referrerId].balance) || 0);
      return apiJson(res, 200, {
        success: true,
        isNew,
        user: {
          telegram_id: id,
          username: users[id].username || "",
          name: [users[id].first_name, users[id].last_name].filter(Boolean).join(" "),
          balance: balance(id),
          totalReferrals: Number(users[id].total_referrals || 0),
          referralEarned: Number(users[id].referral_earned || 0),
          freeGift: freeGiftStatus(users[id])
        }
      });
    });
  }

  if (requestPath === "/api/referral/info" && req.method === "GET") {
    const id = userIdFromRequest(req);
    const users = loadUsers();
    const user = getUser(users, id);
    if (!user) return apiJson(res, 404, { success: false, error: "المستخدم غير مسجل" });
    saveUsers(users);
    return apiJson(res, 200, {
      success: true,
      totalReferrals: Number(user.total_referrals || 0),
      earned: Number(user.referral_earned || 0),
      rewardPerReferral: REFERRAL_REWARD,
      referralLink: `https://t.me/${String(process.env.BOT_USERNAME || "TONIX_BOT").replace(/^@/,"")}?start=ref_${id}`
    });
  }

  if (requestPath === "/api/free-gift/status" && req.method === "GET") {
    const id = userIdFromRequest(req);
    const users = loadUsers();
    const user = getUser(users, id);
    if (!user) return apiJson(res, 404, { success: false, error: "المستخدم غير مسجل" });
    const status = freeGiftStatus(user);
    saveUsers(users);
    return apiJson(res, 200, { success: true, ...status, cooldownHours: 8 });
  }

  if (requestPath === "/api/free-gift/claim" && req.method === "POST") {
    return readJsonBody(req, body => {
      const id = String(body.chatId || userIdFromRequest(req) || "");
      const users = loadUsers();
      const user = getUser(users, id);
      if (!user) return apiJson(res, 404, { success: false, error: "المستخدم غير مسجل" });
      const status = freeGiftStatus(user);
      if (!status.ready) return apiJson(res, 400, { success: false, error: "الصندوق غير جاهز بعد", ...status });
      const amount = FREE_GIFT_AMOUNTS[Math.floor(Math.random() * FREE_GIFT_AMOUNTS.length)];
      user.balance = Number(user.balance || 0) + amount;
      user.free_gift_last_claim = Date.now();
      user.updated_at = new Date().toISOString();
      saveUsers(users);
      balances.set(id, Number(user.balance));
      const next = freeGiftStatus(user);
      return apiJson(res, 200, { success: true, amount, balance: Number(user.balance), ...next });
    });
  }

  if (requestPath === "/api/wallet/transfer" && req.method === "POST") {
    return readJsonBody(req, body => {
      const senderId = String(body.chatId || userIdFromRequest(req) || "");
      const recipientInput = String(body.recipient || "").trim().replace(/^@/, "");
      const amount = Number(body.amount);
      if (!senderId || !recipientInput || !Number.isFinite(amount) || amount <= 0) {
        return apiJson(res, 400, { success: false, error: "بيانات التحويل غير صحيحة" });
      }
      const users = loadUsers();
      if (!users[senderId]) return apiJson(res, 404, { success: false, error: "المرسل غير مسجل" });
      let recipientId = resolveRecipient(users, recipientInput);
      if (!recipientId) return apiJson(res, 404, { success: false, error: "اللاعب غير موجود" });
      if (recipientId === senderId) return apiJson(res, 400, { success: false, error: "لا يمكنك التحويل لنفسك" });
      const rounded = Number(amount.toFixed(2));
      if (rounded <= 0) return apiJson(res, 400, { success: false, error: "المبلغ غير صحيح" });
      const senderBalance = balance(senderId);
      if (rounded > senderBalance) return apiJson(res, 400, { success: false, error: "الرصيد غير كافٍ" });
      setBalance(senderId, senderBalance - rounded);
      setBalance(recipientId, balance(recipientId) + rounded);
      const recipient = users[recipientId];
      return apiJson(res, 200, { success: true, amount: rounded, senderBalance: balance(senderId), recipientId, recipientName: [recipient.first_name, recipient.last_name].filter(Boolean).join(" ") || recipient.username || recipientId });
    });
  }

  if (requestPath === "/api/ranking" && req.method === "GET") {
    const users = loadUsers();
    const ranking = Object.values(users).map(u => ({
      id: String(u.telegram_id), username: u.username || '', name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Player', photo_url: u.photo_url || '',
      balance: Number(u.balance || 0), wins: Number(u.pvp_wins || 0) + Number(u.rocket_wins || 0), games: Number(u.pvp_games || 0) + Number(u.rocket_games || 0), earnings: Number(u.pvp_earnings || 0)
    })).sort((a,b) => b.wins-a.wins || b.balance-a.balance).slice(0, 50);
    return apiJson(res, 200, { success: true, ranking });
  }

  if (requestPath === "/api/statistics" && req.method === "GET") {
    const users = loadUsers();
    const vals = Object.values(users);
    return apiJson(res, 200, {
      success: true, players: vals.length, online: clients.size,
      totalBalance: Number(vals.reduce((s,u)=>s+Number(u.balance||0),0).toFixed(2)),
      totalReferrals: vals.reduce((s,u)=>s+Number(u.total_referrals||0),0),
      pvpRounds: pvpHistory.length, rocketRounds: crashHistory.length
    });
  }

  if (requestPath === "/api/pvp/state" && req.method === "GET") {
    if (pvpRound && pvpRound.status === 'open' && Date.now() >= pvpRound.endsAt) settlePvpRound();
    const r = pvpRound;
    return apiJson(res, 200, { success:true, round: r ? {
      id:r.id, status:r.status, endsAt:r.endsAt, remainingMs: r.status==='open'?Math.max(0,r.endsAt-Date.now()):0,
      pot:Number(r.pot || [...(r.participants?.values?.() || [])].reduce((s,p)=>s+p.amount,0).toFixed(2)),
      participants:[...(r.participants?.values?.() || [])].map(p=>({id:p.id,name:p.name,username:p.username,amount:p.amount,photo_url:p.photo_url||''})),
      winnerId:r.winnerId||null,winnerName:r.winnerName||null
    } : null, history:pvpHistory.slice(0,10) });
  }

  if (requestPath === "/api/pvp/join" && req.method === "POST") {
    return readJsonBody(req, body => {
      const id = String(body.chatId || userIdFromRequest(req) || '');
      const amount = Number(body.amount);
      if (!id || !Number.isFinite(amount) || amount <= 0) return apiJson(res,400,{success:false,error:'المبلغ غير صحيح'});
      const users = loadUsers(); const user = getUser(users,id);
      if (!user) return apiJson(res,404,{success:false,error:'المستخدم غير مسجل'});
      if (pvpRound && pvpRound.status === 'open' && Date.now() >= pvpRound.endsAt) settlePvpRound();
      if (!pvpRound || pvpRound.status === 'finished') {
        pvpRound = { id: makeRoundKey(), status:'open', createdAt:Date.now(), endsAt:Date.now()+PVP_ROUND_MS, participants:new Map(), pot:0 };
        schedulePvpSettlement();
      }
      if (pvpRound.participants.has(id)) return apiJson(res,400,{success:false,error:'أنت داخل هذه الجولة بالفعل',round:pvpRound});
      const rounded = Number(amount.toFixed(2));
      if (rounded > balance(id)) return apiJson(res,400,{success:false,error:'الرصيد غير كافٍ'});
      setBalance(id,balance(id)-rounded);
      const name=[user.first_name,user.last_name].filter(Boolean).join(' ') || user.username || id;
      pvpRound.participants.set(id,{id,name,username:user.username||'',photo_url:user.photo_url||'',amount:rounded});
      pvpRound.pot=Number((pvpRound.pot+rounded).toFixed(2));
      logActivity('pvp',`Player ${id} joined PVP`,{amount:rounded,roundId:pvpRound.id});
      return apiJson(res,200,{success:true,round:{id:pvpRound.id,endsAt:pvpRound.endsAt,remainingMs:Math.max(0,pvpRound.endsAt-Date.now()),pot:pvpRound.pot,participants:[...pvpRound.participants.values()]},balance:balance(id)});
    });
  }

  if (requestPath === "/api/pvp/history" && req.method === "GET") return apiJson(res,200,{success:true,history:pvpHistory.slice(0,30)});

  if (requestPath === "/api/admin/users" && req.method === "GET") {
    const id=userIdFromRequest(req); if(!isDeveloperId(id)) return apiJson(res,403,{success:false,error:'خاصة بالDev فقط'});
    const users=loadUsers(); return apiJson(res,200,{success:true,users:Object.values(users).map(u=>({id:String(u.telegram_id),username:u.username||'',name:[u.first_name,u.last_name].filter(Boolean).join(' ')||'Player',balance:Number(u.balance||0),referrals:Number(u.total_referrals||0),wins:Number(u.pvp_wins||0),losses:Number(u.pvp_losses||0),photo_url:u.photo_url||''}))});
  }

  if (requestPath === "/api/admin/balance" && req.method === "POST") {
    return readJsonBody(req, body => {
      const adminId=userIdFromRequest(req); if(!isDeveloperId(adminId)) return apiJson(res,403,{success:false,error:'خاصة بالDev فقط'});
      const target=String(body.targetId||''); const action=String(body.action||''); const amount=Number(body.amount);
      const users=loadUsers(); if(!target || !users[target]) return apiJson(res,404,{success:false,error:'اللاعب غير موجود'});
      const old=Number(users[target].balance||0); let next=old;
      if(action==='add'){if(!Number.isFinite(amount)||amount<=0)return apiJson(res,400,{success:false,error:'المبلغ غير صحيح'});next=old+amount;}
      else if(action==='set'){if(!Number.isFinite(amount)||amount<0)return apiJson(res,400,{success:false,error:'المبلغ غير صحيح'});next=amount;}
      else if(action==='reset') next=0; else return apiJson(res,400,{success:false,error:'الإجراء غير صحيح'});
      setBalance(target,Number(next.toFixed(2))); logActivity('admin',`Admin ${action} balance`,{adminId,targetId:target,oldBalance:old,newBalance:next});
      return apiJson(res,200,{success:true,targetId:target,balance:balance(target)});
    });
  }

  if (requestPath === "/api/admin/all-balance" && req.method === "POST") {
    return readJsonBody(req, body => {
      const adminId=userIdFromRequest(req); if(!isDeveloperId(adminId)) return apiJson(res,403,{success:false,error:'خاصة بالDev فقط'});
      const amount=Number(body.amount), action=String(body.action||''); if(!Number.isFinite(amount)||amount<0) return apiJson(res,400,{success:false,error:'المبلغ غير صحيح'});
      const users=loadUsers(); let count=0; for(const id of Object.keys(users)){const old=Number(users[id].balance||0);const next=action==='add'?old+amount:action==='set'?amount:0;setBalance(id,Number(next.toFixed(2)));count++;}
      logActivity('admin',`Admin ${action} all balances`,{adminId,amount,count}); return apiJson(res,200,{success:true,count});
    });
  }

  if (requestPath === "/api/admin/activity" && req.method === "GET") {
    const adminId=userIdFromRequest(req); if(!isDeveloperId(adminId)) return apiJson(res,403,{success:false,error:'خاصة بالDev فقط'});
    return apiJson(res,200,{success:true,activity:activityLog.slice(0,100)});
  }

  if (requestPath === "/api/admin/settings" && req.method === "GET") {
    const adminId=userIdFromRequest(req); if(!isDeveloperId(adminId)) return apiJson(res,403,{success:false,error:'خاصة بالDev فقط'});
    return apiJson(res,200,{success:true,settings:{startingBalance:DEMO_STARTING_CREDITS,referralReward:REFERRAL_REWARD,freeGiftCooldownHours:8,freeGiftAmounts:FREE_GIFT_AMOUNTS,pvpRoundSeconds:15,developerId:'7795559285'}});
  }

  if (requestPath === "/api/rocket/my-round-state" && req.method === "GET") {
    const id = userIdFromRequest(req);
    const bet = players.get(id);
    return apiJson(res, 200, {
      roundKey,
      bet: bet ? { ...bet, betRoundKey: roundKey } : null,
      win: null
    });
  }

  if (requestPath === "/api/rocket/cashout" && req.method === "POST") {
    return readJsonBody(req, body => {
      const id = String(body.chatId || userIdFromRequest(req) || "");
      const ok = performCashOut(id, Number(body.multiplier));
      if (!ok) return apiJson(res, 400, { success: false, error: "Invalid cash out", roundKey });
      return apiJson(res, 200, { success: true, roundKey });
    });
  }

  if (requestPath === "/api/rocket/cancel-bet" && req.method === "POST") {
    return readJsonBody(req, body => {
      const id = String(body.chatId || userIdFromRequest(req) || "");
      if (phase !== "countdown") return apiJson(res, 400, { success: false, error: "in_round" });
      const player = players.get(id);
      if (player && !player.cashedOut) {
        setBalance(id, balance(id) + player.betAmount);
        players.delete(id);
      }
      return apiJson(res, 200, { success: true, roundKey });
    });
  }

  // Existing static-file handler.
  return originalHttpHandler(req, res);
});

/* =========================================================
   WEBSOCKET SERVER
   ========================================================= */

const wss = new WebSocket.Server({
  server,
  path: "/ws/ton-rocket"
});

/* =========================================================
   HELPERS
   ========================================================= */

function now() {
  return Date.now();
}

function send(ws, message) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(message) {
  const payload = JSON.stringify(message);

  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function balance(chatId) {
  const id = String(chatId);

  if (!balances.has(id)) {
    const users = loadUsers();
    const stored = users[id]?.balance;
    balances.set(
      id,
      Number.isFinite(Number(stored)) ? Number(stored) : DEMO_STARTING_CREDITS
    );
  }

  return balances.get(id);
}

function setBalance(chatId, value) {
  const id = String(chatId);
  const next = Math.max(0, Number(value) || 0);
  balances.set(id, next);
  const users = loadUsers();
  if (users[id]) {
    users[id].balance = next;
    users[id].updated_at = new Date().toISOString();
    saveUsers(users);
  }
}

function roster() {
  return [...players.values()].map(
    p => ({ ...p })
  );
}

function snapshot() {
  return {
    type: "state_snapshot",

    serverTime: now(),

    state: {
      phase,
      countdown,
      multiplier,

      crashPoint:
        phase === "crashed"
          ? crashPoint
          : undefined,

      startTime,
      roundKey,

      activePlayers:
        roster(),

      playersTotal:
        players.size,

      botsCount: 0,

      viewersCount:
        clients.size,

      crashHistory:
        [...crashHistory]
    }
  };
}

function sendBalance(ws, chatId) {
  const b = balance(chatId);

  send(ws, {
    type: "balance_update",

    chatId:
      String(chatId),

    balance: b,

    available: b,

    availableCredits: b
  });
}

function makeRoundKey() {
  return (
    `${now()}-` +
    Math.random()
      .toString(36)
      .slice(2, 8)
  );
}

function broadcastPhase(
  nextPhase,
  extra = {}
) {
  phase = nextPhase;

  broadcast({
    type: "phase_change",

    phase,

    serverTime: now(),

    roundKey,

    startTime,

    multiplier,

    countdown,

    crashPoint,

    activePlayers:
      roster(),

    playersTotal:
      players.size,

    botsCount: 0,

    viewersCount:
      clients.size,

    ...extra
  });
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

/* =========================================================
   CASH OUT
   ========================================================= */

function performCashOut(
  chatId,
  requestedMultiplier
) {
  const id = String(chatId);

  const player =
    players.get(id);

  if (!player) {
    return false;
  }

  if (player.cashedOut) {
    return false;
  }

  if (phase !== "flying") {
    return false;
  }

  const m =
    Number(requestedMultiplier);

  if (
    !Number.isFinite(m) ||
    m < 1 ||
    m > multiplier
  ) {
    return false;
  }

  const winAmount =
    Number(
      (
        player.betAmount * m
      ).toFixed(2)
    );

  player.cashedOut = true;
  player.cashOutMultiplier = m;
  player.winAmount = winAmount;

  // Demo credits only
  setBalance(
    id,
    balance(id) + winAmount
  );

  broadcast({
    type:
      "cash_out_response",

    success: true,

    chatId: id,

    multiplier: m,

    winAmount,

    roundKey
  });

  broadcast({
    type:
      "player_cashed_out",

    chatId: id,

    multiplier: m,

    winAmount,

    roundKey,

    botsCount: 0,

    viewersCount:
      clients.size
  });

  return true;
}

/* =========================================================
   MESSAGE HANDLER
   ========================================================= */

function handleMessage(
  ws,
  message
) {
  const type =
    message?.type;

  const chatId =
    String(
      message?.chatId ??
      "demo"
    );

  /* ---------------- PING ---------------- */

  if (type === "ping") {
    send(ws, {
      type: "pong",
      serverTime: now()
    });

    return;
  }

  /* ---------------- CONNECT ---------------- */

  if (type === "connect") {
    send(
      ws,
      snapshot()
    );

    sendBalance(
      ws,
      chatId
    );

    return;
  }

  /* ---------------- RESYNC ---------------- */

  if (type === "resync") {
    send(
      ws,
      snapshot()
    );

    sendBalance(
      ws,
      chatId
    );

    return;
  }

  /* ---------------- PLACE BET ---------------- */

  if (type === "place_bet") {

    if (phase !== "countdown") {

      send(ws, {
        type:
          "bet_response",

        success: false,

        error:
          "Bets are closed"
      });

      return;
    }

    const amount =
      Number(
        message.betAmount
      );

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {

      send(ws, {
        type:
          "bet_response",

        success: false,

        error:
          "Invalid demo bet amount"
      });

      return;
    }

    if (
      amount >
      balance(chatId)
    ) {

      send(ws, {
        type:
          "bet_response",

        success: false,

        error:
          "Insufficient demo credits"
      });

      return;
    }

    if (
      players.has(chatId)
    ) {

      send(ws, {
        type:
          "bet_response",

        success: false,

        error:
          "Bet already exists"
      });

      return;
    }

    setBalance(
      chatId,
      balance(chatId) -
        amount
    );

    const autoValue =
      Number(
        message.autoCashOut
      );

    const player = {
      chatId,

      name:
        String(
          message.name ||
          "Demo Player"
        ).slice(0, 40),

      betAmount:
        amount,

      cashedOut: false,

      isPending: false,

      isWaiting: false,

      autoCashOut:
        Number.isFinite(
          autoValue
        )
          ? autoValue
          : null
    };

    players.set(
      chatId,
      player
    );

    send(ws, {
      type:
        "bet_response",

      success: true,

      roundKey
    });

    broadcast({
      type:
        "pending_bet_added",

      player: {
        ...player,

        isPending: true
      }
    });

    broadcast({
      type:
        "self_roster_entry",

      player: {
        ...player
      }
    });

    sendBalance(
      ws,
      chatId
    );

    return;
  }

  /* ---------------- AUTO CASHOUT ---------------- */

  if (
    type ===
    "set_auto_cashout"
  ) {

    const player =
      players.get(chatId);

    const value =
      Number(
        message.multiplier
      );

    if (
      player &&
      Number.isFinite(value) &&
      value >= 1
    ) {
      player.autoCashOut =
        value;
    }

    send(ws, {
      type:
        "auto_cashout_response",

      success: true,

      multiplier:
        player?.autoCashOut ??
        null,

      roundKey
    });

    return;
  }

  /* ---------------- CANCEL BET ---------------- */

  if (
    type ===
    "cancel_bet"
  ) {

    if (phase !== "countdown") {

      send(ws, {
        type:
          "bet_cancelled",

        success: false,

        error:
          "Bets are closed"
      });

      return;
    }

    const player =
      players.get(chatId);

    if (
      player &&
      !player.cashedOut
    ) {

      setBalance(
        chatId,
        balance(chatId) +
          player.betAmount
      );

      players.delete(
        chatId
      );
    }

    send(ws, {
      type:
        "bet_cancelled",

      success: true,

      roundKey
    });

    sendBalance(
      ws,
      chatId
    );

    return;
  }

  /* ---------------- CASH OUT ---------------- */

  if (
    type ===
    "cash_out"
  ) {

    const requested =
      Number(
        message.multiplier
      );

    if (
      message.roundKey &&
      message.roundKey !==
        roundKey
    ) {

      send(ws, {
        type:
          "cash_out_response",

        success: false,

        error:
          "Invalid round",

        roundKey
      });

      return;
    }

    if (phase !== "flying") {

      send(ws, {
        type:
          "cash_out_response",

        success: false,

        error:
          "Rocket already crashed",

        roundKey
      });

      return;
    }

    if (
      !players.has(chatId)
    ) {

      send(ws, {
        type:
          "cash_out_response",

        success: false,

        error:
          "No active bet",

        roundKey
      });

      return;
    }

    if (
      !performCashOut(
        chatId,
        requested
      )
    ) {

      send(ws, {
        type:
          "cash_out_response",

        success: false,

        error:
          "Invalid cash out",

        roundKey
      });

      return;
    }

    sendBalance(
      ws,
      chatId
    );

    return;
  }

  /* ---------------- UNKNOWN ---------------- */

  send(ws, {
    type: "error",
    error:
      "Unknown message type"
  });
}

/* =========================================================
   WEBSOCKET CONNECTION
   ========================================================= */

wss.on(
  "connection",
  ws => {

    clients.add(ws);

    send(
      ws,
      snapshot()
    );

    ws.on(
      "message",
      raw => {

        try {

          const message =
            JSON.parse(
              raw.toString()
            );

          handleMessage(
            ws,
            message
          );

        } catch (error) {

          console.error(
            "Message error:",
            error
          );

          send(ws, {
            type: "error",
            error:
              "Invalid JSON message"
          });
        }
      }
    );

    ws.on(
      "close",
      () => {
        clients.delete(ws);
      }
    );

    ws.on(
      "error",
      () => {
        clients.delete(ws);
      }
    );
  }
);

/* =========================================================
   GAME LOOP
   ========================================================= */

async function gameLoop() {

  while (true) {

    roundKey =
      makeRoundKey();

    crashPoint =
      Number(
        (
          1.35 +
          Math.random() * 5.15
        ).toFixed(2)
      );

    multiplier = 1;

    startTime = 0;

    players.clear();

    phase =
      "countdown";

    /* COUNTDOWN */

    for (
      countdown = 5;
      countdown >= 1;
      countdown--
    ) {

      broadcast({
        type:
          "countdown_tick",

        serverTime:
          now(),

        roundKey,

        countdown,

        activePlayers:
          roster(),

        playersTotal:
          players.size,

        botsCount: 0,

        viewersCount:
          clients.size
      });

      if (
        countdown === 5
      ) {
        broadcastPhase(
          "countdown"
        );
      }

      await sleep(1000);
    }

    /* FLYING */

    startTime =
      now();

    multiplier = 1;

    broadcastPhase(
      "flying",
      {
        startTime,

        multiplier: 1,

        countdown: 0
      }
    );

    /* ROCKET */

    while (
      multiplier <
      crashPoint
    ) {

      multiplier =
        Number(
          Math.min(
            crashPoint - 0.01,
            multiplier *
              1.045
          ).toFixed(2)
        );

      if (
        multiplier < 1
      ) {
        multiplier = 1;
      }

      /* AUTO CASHOUT */

      for (
        const player
        of players.values()
      ) {

        if (
          !player.cashedOut &&
          player.autoCashOut &&
          multiplier >=
            player.autoCashOut
        ) {

          performCashOut(
            player.chatId,
            player.autoCashOut
          );
        }
      }

      broadcast({
        type:
          "multiplier_update",

        serverTime:
          now(),

        roundKey,

        multiplier
      });

      await sleep(180);
    }

    /* CRASH */

    phase =
      "crashed";

    multiplier =
      crashPoint;

    crashHistory.push(
      crashPoint
    );

    crashHistory =
      crashHistory.slice(-20);

    broadcast({
      type: "crash",

      serverTime:
        now(),

      roundKey,

      crashPoint,

      multiplier:
        crashPoint,

      activePlayers:
        roster(),

      playersTotal:
        players.size,

      botsCount: 0,

      viewersCount:
        clients.size,

      crashHistory:
        [...crashHistory]
    });

    await sleep(2000);
  }
}

/* =========================================================
   START
   ========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `HTTP server running on port ${PORT}`
    );

    console.log(
      `WebSocket endpoint: /ws/ton-rocket`
    );

    console.log(
      "Virtual credits only — no real-money/TON transactions."
    );
  }
);

gameLoop().catch(
  error => {

    console.error(
      "Game loop stopped:",
      error
    );

    process.exit(1);
  }
);
