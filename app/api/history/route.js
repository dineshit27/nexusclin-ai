import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";

export async function GET() {
  const db = getServerSupabase();
  if (!db) return NextResponse.json({ ok: true, items: [] });

  try {
    const { data, error } = await db
      .from("analyses")
      .select("id, created_at, patient_label, score, eligible, overall_status, trial_name, summary")
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) {
      console.warn("[Cohort History Warning]", error.message);
      return NextResponse.json({ ok: true, items: [] });
    }

    return NextResponse.json({ ok: true, items: data || [] });
  } catch (err) {
    console.warn("[Cohort History Catch]", err.message);
    return NextResponse.json({ ok: true, items: [] });
  }
}
