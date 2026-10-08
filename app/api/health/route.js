import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const checks = {
    gemini: !!process.env.GEMINI_API_KEY,
    supabase: !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  };

  const allHealthy = Object.values(checks).every(Boolean);

  return NextResponse.json(
    {
      ok: allHealthy,
      status: allHealthy ? "healthy" : "degraded",
      pipeline: checks,
      timestamp: new Date().toISOString(),
    },
    { status: allHealthy ? 200 : 503 }
  );
}
