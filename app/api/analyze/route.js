import { NextResponse } from "next/server";
import pdf from "pdf-parse";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

async function parsePdfByPages(buffer) {
  const pages = [];
  const options = {
    pagerender: function(pageData) {
      return pageData.getTextContent({ normalizeWhitespace: true }).then(function(textContent) {
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

async function callGeminiApi(promptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }

  const primaryUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
  const fallbackUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: promptText }]
      }
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json"
    }
  };

  let res = await fetch(primaryUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok && res.status === 404) {
    res = await fetch(fallbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(payload)
    });
  }

  if (!res.ok) {
    const errorText = await res.text();
    let errMessage = `Gemini API error (status ${res.status})`;
    try {
      const errJson = JSON.parse(errorText);
      if (errJson.error?.message) {
        errMessage = errJson.error.message;
      }
    } catch {}
    throw new Error(errMessage);
  }

  const data = await res.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error("Gemini returned an empty analysis response.");
  }

  try {
    return JSON.parse(rawText);
  } catch (err) {
    const cleaned = rawText.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
    return JSON.parse(cleaned);
  }
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

    const rawResult = await callGeminiApi(prompt);

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
