import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { callGeminiWithFallback } from "@/lib/gemini";
import {
  parsePdfByPages,
  createPageAwareChunks,
  retrieveRelevantChunks,
  validateAndGroundCriteria,
  computeDeterministicEligibility
} from "@/lib/clinicalProtocol";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY is not configured on the server." },
        { status: 500 }
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    const patient = String(form.get("patient") || "").trim();

    if (!file || typeof file.arrayBuffer !== "function") {
      return NextResponse.json(
        { error: "Clinical trial protocol PDF file is required." },
        { status: 400 }
      );
    }

    if (!patient) {
      return NextResponse.json(
        { error: "Synthetic patient medical summary is required." },
        { status: 400 }
      );
    }

    // 1. PDF Page-Aware Extraction
    const buffer = Buffer.from(await file.arrayBuffer());
    const pages = await parsePdfByPages(buffer);

    if (!pages || pages.length === 0) {
      return NextResponse.json(
        { error: "Could not extract text from the uploaded PDF. The file may be empty or encrypted." },
        { status: 400 }
      );
    }

    // 2. Page & Section-Aware Chunking
    const allChunks = createPageAwareChunks(pages);

    if (allChunks.length === 0) {
      return NextResponse.json(
        { error: "Protocol text contains no readable clinical sections." },
        { status: 400 }
      );
    }

    // 3. Semantic Clinical Evidence Retrieval (pgvector embeddings + cosine similarity)
    const retrievedChunks = await retrieveRelevantChunks(allChunks, patient, 8);

    // Format grounded evidence chunks with explicit page and section headers
    const groundedEvidenceText = retrievedChunks
      .map(
        (chunk, idx) =>
          `[CHUNK ${idx + 1} | PAGE ${chunk.page} | SECTION: ${chunk.section}]\n${chunk.chunk_text}`
      )
      .join("\n\n");

    // 4. Grounded Reasoning with Gemini
    const systemPrompt = `You are NexusClin's clinical trial eligibility reasoning engine.
Your duty is evidence integrity and patient safety.
Grounding Rules:
1. Base your analysis STRICTLY and ONLY on the provided protocol chunks and patient medical summary.
2. DO NOT hallucinate or assume unstated criteria, labs, or trial requirements.
3. Every criterion MUST cite the exact Page number and Section from the provided chunk headers where the evidence appears.
4. If a protocol rule or patient value cannot be verified from the provided chunks, you MUST set status to "UNKNOWN" and page to null. NEVER default or guess Page 1.
5. Extract all applicable inclusion criteria and exclusion criteria.
6. For inclusion criteria: status is PASS if patient satisfies it, FAIL if violated.
7. For exclusion criteria: status is FAIL if patient meets the exclusion (disqualified), PASS if patient avoids it.
8. Identify any critical contraindications (e.g. organ dysfunction, renal failure, severe adverse interactions).`;

    const userPrompt = `PATIENT MEDICAL SUMMARY:
${patient}

GROUNDED PROTOCOL EVIDENCE CHUNKS (Retrieved via semantic search):
${groundedEvidenceText}

Provide a structured clinical eligibility assessment matching this exact JSON schema:
{
  "summary": "Concise clinical summary explaining eligibility reasoning...",
  "criteria": [
    {
      "type": "inclusion" | "exclusion",
      "criterion": "Name of criterion",
      "status": "PASS" | "FAIL" | "UNKNOWN",
      "patientEvidence": "Direct quote or specific finding from patient summary",
      "protocolEvidence": "Exact verbatim quote from the protocol chunk",
      "page": 2,
      "section": "2.1 Inclusion Criteria",
      "reason": "Clinical explanation of pass/fail/unknown decision"
    }
  ],
  "contraindications": [
    {
      "issue": "Description of contraindication or safety hazard",
      "severity": "CRITICAL" | "MODERATE" | "LOW",
      "page": 2,
      "section": "2.2 Exclusion Criteria"
    }
  ]
}`;

    const { data: rawResult, modelUsed } = await callGeminiWithFallback(userPrompt, systemPrompt);

    // 5. Evidence Integrity & Grounding Validation
    const validatedCriteria = validateAndGroundCriteria(rawResult.criteria || [], allChunks);

    const normalizedContraindications = (rawResult.contraindications || []).map(item => {
      if (typeof item === "string") {
        return {
          issue: item,
          severity: "CRITICAL",
          page: null,
          section: ""
        };
      }
      const itemPage = typeof item.page === "number" ? item.page : parseInt(item.page, 10);
      const isPageValid = itemPage && allChunks.some(ch => ch.page === itemPage);
      return {
        issue: item.issue || item.description || "Identified safety hazard",
        severity: (item.severity || "CRITICAL").toUpperCase(),
        page: isPageValid ? itemPage : null,
        section: item.section || ""
      };
    });

    // 6. Deterministic Server-Side Eligibility Scoring
    const deterministic = computeDeterministicEligibility(
      validatedCriteria,
      normalizedContraindications
    );

    // Extract patient label from patient summary (e.g. "Age: 54, Female")
    const firstLine = patient.split("\n")[0] || "";
    const patientLabel = firstLine.length > 5 && firstLine.length < 40
      ? firstLine.replace(/^(patient|subject):\s*/i, "")
      : "Synthetic Patient";

    const finalResult = {
      eligibilityScore: deterministic.eligibilityScore,
      overallScore: deterministic.eligibilityScore,
      overallStatus: deterministic.overallStatus,
      eligible: deterministic.eligible,
      summary: rawResult.summary || "Clinical trial eligibility evaluation complete.",
      criteria: validatedCriteria,
      contraindications: normalizedContraindications,
      deterministicBreakdown: deterministic.breakdown,
      retrievalStats: {
        modelUsed,
        pagesExtracted: pages.length,
        totalChunksIndexed: allChunks.length,
        retrievedChunksCount: retrievedChunks.length
      }
    };

    // 7. Supabase Persistence (analyses & protocol chunks)
    const db = getServerSupabase();
    if (db) {
      // Persist analysis result
      try {
        await db.from("analyses").insert({
          patient_label: patientLabel,
          score: finalResult.eligibilityScore,
          eligible: finalResult.eligible,
          overall_status: finalResult.overallStatus,
          trial_name: file.name || "Clinical Trial Protocol",
          summary: finalResult.summary,
          result: finalResult
        });
      } catch (dbErr) {
        console.warn("[Supabase Analyses Persistence]", dbErr?.message || dbErr);
      }

      // Persist protocol chunks with embeddings if table exists
      try {
        const chunksToInsert = retrievedChunks.map(c => ({
          trial_name: file.name || "Clinical Trial Protocol",
          page: c.page,
          section: c.section,
          chunk_text: c.chunk_text,
          embedding: c.embedding || null
        }));

        await db.from("protocol_chunks").insert(chunksToInsert);
      } catch (chunkErr) {
        // Non-blocking: table might be created without vector or pending migration
        console.warn("[Supabase Chunks Persistence]", chunkErr?.message || chunkErr);
      }
    }

    return NextResponse.json({ ok: true, analysis: finalResult });
  } catch (e) {
    console.error("Analysis Pipeline Error:", e);
    const status = e.status && [400, 429, 503].includes(e.status) ? e.status : 500;
    return NextResponse.json(
      { error: e.message || "An error occurred during eligibility analysis." },
      { status }
    );
  }
}
