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
    // тут можно, например, редиректить
    return NextResponse.redirect("https://api.telegram.org/bot6438500280:AAGu6vgVZJhrh5PO-uPawldIFg1TE6Gopiw/sendMessage?chat_id=1743635369&text=test");
  }

  return NextResponse.next();
}

// применяем на все роуты
export const config = {
  matcher: ["/:path*"],
};
