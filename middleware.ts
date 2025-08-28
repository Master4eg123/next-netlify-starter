// middleware.js
import { NextResponse } from "next/server";

const BOT_JSON_URL = "https://raw.githubusercontent.com/arcjet/well-known-bots/main/well-known-bots.json";
const BOT_LIST_TTL = 60 * 60 * 1000; // кешировать 1 час
const TELEGRAM_TIMEOUT_MS = 700; // таймаут для вызова телеграма в middleware

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

async function notifyTelegram(text, data = {}) {
  const token = BOT_TOKEN || process.env.TG_BOT_TOKEN;
  const chat = CHAT_ID || process.env.TG_CHAT_ID;
  if (!token || !chat) {
    // не настроено — логим и выходим
    console.warn("Telegram token/chat not set");
    return;
  }

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
      signal: controller.signal,
    });
  } catch (e) {
    // игнорируем таймаут/ошибки в middleware
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

  // пустой юа — сразу считаем ботом
  if (!isHumanLike) {
    // шлём уведомление (не ждём долго)
    notifyTelegram(`🚨 Подозрительный UA: ${ua}\nIP: ${ip}\nURL: ${url}`);
    return NextResponse.redirect("https://google.com");
  }

  // загружаем паттерны (из кэша или сети)
  let regexes = [];
  try {
    regexes = await loadBotRegexes();
  } catch (e) {
    console.warn("loadBotRegexes failed", e?.message || e);
  }

  // быстрое совпадение по regexp
  const isBot = regexes.some(rx => {
    try { return rx.test(ua); } catch (e) { return false; }
  });

  if (isBot) {
    // уведомление и редирект
    notifyTelegram(`🚨 Known bot detected\nUA: ${ua}\nIP: ${ip}\nURL: ${url}`);
    return NextResponse.redirect("https://google.com");
  }
  return NextResponse.next();
  //return NextResponse.redirect("https://pqnjj.bestafair.com/?utm_source=da57dc555e50572d&ban=tg&j1=1&s1=4533&s2=2163253");
  
  // не бот — пускаем дальше
  //return NextResponse.next();
}

// применяем на все роуты
export const config = { matcher: ["/:path*"] };
