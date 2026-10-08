import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  if (!supabase) return NextResponse.json({ ok: true, items: [] });
  const { data, error } = await supabase.from("analyses").select("*").order("created_at", { ascending: false }).limit(25);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, items: data });
}
