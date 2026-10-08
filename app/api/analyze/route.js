import { NextResponse } from "next/server";
import pdf from "pdf-parse";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

async function parsePdfByPages(buffer) {
  const pages = [];
  const options = {
    pagerender: function (pageData) {
      return pageData.getTextContent({ normalizeWhitespace: true }).then(function (textContent) {
        let lastY, text = "";
        for (let item of textContent.items) {
          if (!item.str) continue;
          if (lastY === undefined || lastY === item.transform[5]) {
            text += item.str + " ";
          } else {
            text += "\n" + item.str + " ";
          }
          lastY = item.transform[5];
        }
        const pageNum = pageData.pageIndex + 1;
        const cleanText = text.replace(/[ \t]+/g, " ").trim();
        if (cleanText) {
          pages.push({ page: pageNum, text: cleanText });
        }
        return cleanText;
      });
    }
  };

  try {
    const parsed = await pdf(buffer, options);
    if (pages.length === 0 && parsed.text) {
      pages.push({ page: 1, text: parsed.text.trim() });
    }
    return pages;
  } catch (e) {
    console.error("PDF page extraction fallback:", e);
    const parsed = await pdf(buffer);
    const clean = (parsed.text || "").trim();
    return clean ? [{ page: 1, text: clean }] : [];
  }
}

function extractTextFromInteractionResponse(data) {
  if (typeof data.output === "string") return data.output;
  if (Array.isArray(data.outputs)) {
    for (const out of data.outputs) {
      if (typeof out.text === "string") return out.text;
      if (typeof out === "string") return out;
      if (out.content) {
        if (typeof out.content === "string") return out.content;
        if (Array.isArray(out.content.parts)) {
          return out.content.parts.map(p => p.text || "").join("\n");
        }
      }
    }
  }
  if (Array.isArray(data.candidates)) {
    const parts = data.candidates[0]?.content?.parts;
    if (Array.isArray(parts)) {
      return parts.map(p => p.text || "").join("\n");
    }
  }
  if (typeof data.text === "string") return data.text;
  if (data.result && typeof data.result === "string") return data.result;
  return JSON.stringify(data);
}

function parseJsonFromText(rawText) {
  if (!rawText) throw new Error("Gemini returned empty text output.");
  try {
    return JSON.parse(rawText);
  } catch (e) {
    const cleaned = rawText.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch (e2) {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        const jsonSubstring = cleaned.slice(start, end + 1);
        return JSON.parse(jsonSubstring);
      }
      throw new Error("Failed to parse structured JSON from Gemini response.");
    }
  }
}

const CANDIDATE_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash"
];

function isTemporaryCapacityError(status, message) {
  // Only retry for clear capacity/rate-limit/gateway HTTP codes.
  // Deliberately exclude 500 — it may indicate a bad request or server bug, not capacity.
  if ([429, 502, 503, 504].includes(status)) return true;

  const msg = (message || "").toLowerCase();
  const capacityKeywords = [
    "high demand",
    "spikes in demand",
    "try again later",
    "temporarily unavailable",
    "overloaded",
    "resource exhausted",
    "rate limit",
    "quota exceeded",
    "rate_limit_exceeded",
    "capacity",
  ];

  return capacityKeywords.some(keyword => msg.includes(keyword));
}


async function callGeminiInteractionsApi(promptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }

  const url = "https://generativelanguage.googleapis.com/v1beta/interactions";
  let lastError = null;

  for (let i = 0; i < CANDIDATE_MODELS.length; i++) {
    const model = CANDIDATE_MODELS[i];
    const isLastModel = i === CANDIDATE_MODELS.length - 1;

    try {
      const payload = {
        model,
        input: promptText,
        generation_config: {
          thinking_level: "medium"
        }
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errorText = await res.text();
        let errMessage = `Gemini API error (status ${res.status})`;
        try {
          const errJson = JSON.parse(errorText);
          if (errJson.error?.message) {
            errMessage = errJson.error.message;
          }
        } catch {}

        if (!isLastModel && isTemporaryCapacityError(res.status, errMessage)) {
          console.warn(`[Gemini Fallback] Model ${model} returned temporary capacity/availability error (${res.status}: ${errMessage}). Retrying with fallback model ${CANDIDATE_MODELS[i + 1]}...`);
          lastError = new Error(`${model} capacity error: ${errMessage}`);
          continue;
        }

        throw new Error(errMessage);
      }

      const data = await res.json();
      const rawText = extractTextFromInteractionResponse(data);
      return parseJsonFromText(rawText);
    } catch (err) {
      if (!isLastModel && isTemporaryCapacityError(0, err.message)) {
        console.warn(`[Gemini Fallback] Model ${model} caught temporary availability error (${err.message}). Retrying with fallback model ${CANDIDATE_MODELS[i + 1]}...`);
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("All configured Gemini models failed due to temporary capacity limits.");
}


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
      return NextResponse.json({ error: "Clinical trial protocol PDF file is required." }, { status: 400 });
    }

    if (!patient) {
      return NextResponse.json({ error: "Synthetic patient medical summary is required." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const pages = await parsePdfByPages(buffer);

    if (!pages || pages.length === 0) {
      return NextResponse.json(
        { error: "Could not extract text from the uploaded PDF. The file may be empty or corrupted." },
        { status: 400 }
      );
    }

    const protocolPagesText = pages
      .map(p => `--- PAGE ${p.page} ---\n${p.text}`)
      .join("\n\n");

    const prompt = `You are NexusClin's clinical trial eligibility reasoning engine.
Analyze the provided SYNTHETIC patient medical summary against the clinical trial protocol pages.

PATIENT MEDICAL SUMMARY:
${patient}

CLINICAL TRIAL PROTOCOL PAGES:
${protocolPagesText}

CRITICAL INSTRUCTIONS & GROUNDING RULES:
1. Base your analysis STRICTLY and ONLY on the provided protocol pages and patient medical summary.
2. DO NOT invent protocol criteria, patient facts, or page numbers.
3. Extract all explicit inclusion criteria and exclusion criteria from the protocol.
4. For inclusion criteria, status is PASS if patient satisfies it, FAIL if violated.
5. For exclusion criteria, status is FAIL if patient meets the exclusion condition (disqualified), PASS if patient avoids the exclusion.
6. If information is missing or unclear for any criterion, mark status as "UNKNOWN".
7. For EVERY criterion:
   - "type": "inclusion" or "exclusion"
   - "criterion": short name/description of the criterion
   - "status": "PASS" | "FAIL" | "UNKNOWN"
   - "patientEvidence": exact or summary quote from patient summary
   - "protocolEvidence": exact short quote from the protocol text
   - "page": actual 1-indexed page number where protocolEvidence appears
   - "section": section or paragraph reference if available in protocol (e.g. "2.1", "3.2"), or empty string if not specified
   - "reason": concise explanation of why patient passes/fails
8. Identify any critical contraindications (e.g. renal failure, eGFR below exclusion threshold, organ dysfunction).
9. Calculate eligibilityScore (0 to 100 integer) reflecting proportion of criteria satisfied, penalized for failed exclusion criteria or contraindications.
10. Determine overallStatus: "ELIGIBLE" if eligibilityScore >= 80 and no critical contraindications, else "NOT_ELIGIBLE".

Return ONLY a structured JSON object matching this exact schema:
{
  "eligibilityScore": 75,
  "overallStatus": "NOT_ELIGIBLE",
  "summary": "Detailed summary explaining eligibility evaluation...",
  "criteria": [
    {
      "type": "inclusion",
      "criterion": "...",
      "status": "PASS",
      "patientEvidence": "...",
      "protocolEvidence": "...",
      "page": 1,
      "section": "2.1",
      "reason": "..."
    }
  ],
  "contraindications": [
    {
      "issue": "...",
      "severity": "CRITICAL",
      "page": 1,
      "section": "2.2"
    }
  ]
}`;

    const rawResult = await callGeminiInteractionsApi(prompt);

    const eligibilityScore = Math.max(
      0,
      Math.min(100, Number(rawResult.eligibilityScore ?? rawResult.overallScore) || 0)
    );
    const overallStatus =
      rawResult.overallStatus === "ELIGIBLE" || rawResult.eligible === true ? "ELIGIBLE" : "NOT_ELIGIBLE";
    const isEligible = overallStatus === "ELIGIBLE";

    const normalizedCriteria = (rawResult.criteria || []).map(c => ({
      type: c.type || "inclusion",
      criterion: c.criterion || "Unspecified Criterion",
      status: c.status || "UNKNOWN",
      patientEvidence: c.patientEvidence || "",
      protocolEvidence: c.protocolEvidence || c.evidence || "",
      evidence: c.protocolEvidence || c.evidence || "",
      page: typeof c.page === "number" ? c.page : parseInt(c.page, 10) || 1,
      section: c.section || "",
      reason: c.reason || ""
    }));

    const normalizedContraindications = (rawResult.contraindications || []).map(item => {
      if (typeof item === "string") return item;
      return {
        issue: item.issue || item.description || item.criterion || "Critical contraindication detected",
        severity: item.severity || "CRITICAL",
        page: item.page || 1,
        section: item.section || ""
      };
    });

    const finalResult = {
      eligibilityScore,
      overallScore: eligibilityScore,
      overallStatus,
      eligible: isEligible,
      summary: rawResult.summary || "",
      criteria: normalizedCriteria,
      contraindications: normalizedContraindications
    };

    if (supabase) {
      try {
        await supabase.from("analyses").insert({
          patient_label: "Synthetic Patient",
          score: finalResult.overallScore,
          eligible: finalResult.eligible,
          trial_name: file.name || "Clinical Trial Protocol",
          summary: finalResult.summary,
          result: finalResult
        });
      } catch (dbError) {
        console.warn("Supabase persistence warning:", dbError?.message || dbError);
      }
    }

    return NextResponse.json({ ok: true, analysis: finalResult });
  } catch (e) {
    console.error("Analysis API Error:", e);
    return NextResponse.json({ error: e.message || "Analysis failed." }, { status: 500 });
  }
}
