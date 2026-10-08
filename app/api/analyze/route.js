import { NextResponse } from "next/server";
import OpenAI from "openai";
import pdf from "pdf-parse";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

function chunkText(text, size = 1400) {
  const clean = text.replace(/\s+/g, " ").trim();
  const chunks = [];
  for (let i = 0; i < clean.length; i += size) {
    chunks.push(clean.slice(i, i + size));
  }
  return chunks;
}

export async function POST(req) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY is not configured on the server." }, { status: 500 });
    }

    const form = await req.formData();
    const file = form.get("file");
    const patient = String(form.get("patient") || "");
    if (!file || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "PDF is required." }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const parsed = await pdf(buffer);
    const pages = parsed.numpages || 1;
    const chunks = chunkText(parsed.text);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Lightweight semantic retrieval: ask the model to select the most relevant
    // protocol chunks before doing the final structured eligibility decision.
    const retrieval = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a clinical-trial retrieval assistant. Return JSON only. Select the most relevant chunks for patient eligibility. Never invent evidence." },
        { role: "user", content: JSON.stringify({ patient, protocolChunks: chunks.map((text, i) => ({ id: i + 1, page: Math.min(pages, Math.floor(i / Math.max(1, Math.ceil(chunks.length / pages))) + 1), text })) }) }
      ]
    });
    const selected = JSON.parse(retrieval.choices[0].message.content || '{"chunkIds":[]}');
    const selectedIds = Array.isArray(selected.chunkIds) ? selected.chunkIds : [];
    const relevant = chunks.map((text, i) => ({ id: i + 1, text, page: Math.min(pages, Math.floor(i / Math.max(1, Math.ceil(chunks.length / pages))) + 1) }))
      .filter(x => selectedIds.includes(x.id)).slice(0, 12);
    const evidence = relevant.length ? relevant : chunks.slice(0, 12).map((text,i)=>({id:i+1,text,page:1}));

    const analysis = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `You are NexusClin's eligibility reasoning engine. Evaluate a SYNTHETIC patient against a clinical trial protocol using ONLY the supplied evidence. Do not diagnose or invent criteria. Return JSON only with this shape:
{"overallScore":0,"eligible":false,"summary":"...","criteria":[{"criterion":"...","status":"PASS|FAIL","reason":"...","evidence":"exact short quote from supplied evidence","page":1}],"contraindications":["..."]}
Score should reflect criteria satisfied. If evidence is insufficient, mark the criterion FAIL or explain that manual review is required. Evidence must be an exact quote copied from supplied protocol evidence.` },
        { role: "user", content: JSON.stringify({ patient, protocolEvidence: evidence }) }
      ]
    });

    const result = JSON.parse(analysis.choices[0].message.content || "{}");
    result.overallScore = Math.max(0, Math.min(100, Number(result.overallScore) || 0));

    if (supabase) {
      await supabase.from("analyses").insert({
        patient_label: "Synthetic Patient",
        score: result.overallScore,
        eligible: !!result.eligible,
        trial_name: file.name,
        summary: result.summary || "",
        result
      });
    }

    return NextResponse.json({ ok: true, analysis: result });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: e.message || "Analysis failed." }, { status: 500 });
  }
}
