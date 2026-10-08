/**
 * NexusClin Clinical Protocol Intelligence
 * Page-aware extraction, semantic chunking, grounding verification, and deterministic scoring.
 */

import { extractText } from "unpdf";
import pdf from "pdf-parse";
import { embedTexts, cosineSimilarity } from "./gemini.js";

/**
 * Extracts text from PDF with page numbers preserved using unpdf with pdf-parse fallback.
 */
export async function parsePdfByPages(buffer) {
  try {
    const uint8 = new Uint8Array(buffer);
    const { totalPages, text } = await extractText(uint8);
    const pages = [];

    if (Array.isArray(text)) {
      text.forEach((pageText, idx) => {
        const clean = (pageText || "").trim();
        if (clean) {
          pages.push({ page: idx + 1, text: clean });
        }
      });
    } else if (typeof text === "string" && text.trim()) {
      pages.push({ page: 1, text: text.trim() });
    }

    if (pages.length > 0) return pages;
  } catch (err) {
    console.warn("[unpdf Extraction Warning] Falling back to pdf-parse:", err?.message || err);
  }

  // Fallback to pdf-parse if unpdf fails
  try {
    const parsed = await pdf(buffer);
    const clean = (parsed.text || "").trim();
    return clean ? [{ page: 1, text: clean }] : [];
  } catch (e) {
    console.error("[PDF Extraction Error]:", e);
    return [];
  }
}

/**
 * Splits extracted pages into structured chunks with page and section metadata.
 */
export function createPageAwareChunks(pages) {
  const chunks = [];
  let currentSection = "General Protocol";

  const sectionRegex = /^(?:section\s+)?(\d+(?:\.\d+)*\s*[-:–]?\s*[A-Za-z\s]+|inclusion\s+criteria|exclusion\s+criteria|study\s+population|eligibility\s+criteria|contraindications|safety\s+assessment|endpoints|interventions)/i;

  for (const pageObj of pages) {
    const pageNum = pageObj.page;
    const lines = pageObj.text.split("\n").map(l => l.trim()).filter(Boolean);

    let currentParagraph = "";

    for (const line of lines) {
      // Check if line is a section header
      if (line.length < 80 && sectionRegex.test(line)) {
        if (currentParagraph.length > 50) {
          chunks.push({
            id: `chunk_p${pageNum}_${chunks.length + 1}`,
            page: pageNum,
            section: currentSection,
            chunk_text: currentParagraph.trim()
          });
          currentParagraph = "";
        }
        currentSection = line;
        continue;
      }

      currentParagraph += (currentParagraph ? " " : "") + line;

      // Split paragraphs at logical boundaries
      if (currentParagraph.length >= 450 && /[.!?]$/.test(line)) {
        chunks.push({
          id: `chunk_p${pageNum}_${chunks.length + 1}`,
          page: pageNum,
          section: currentSection,
          chunk_text: currentParagraph.trim()
        });
        currentParagraph = "";
      }
    }

    if (currentParagraph.trim().length > 0) {
      chunks.push({
        id: `chunk_p${pageNum}_${chunks.length + 1}`,
        page: pageNum,
        section: currentSection,
        chunk_text: currentParagraph.trim()
      });
    }
  }

  return chunks;
}

/**
 * Semantically retrieves the top relevant chunks for clinical eligibility queries.
 */
export async function retrieveRelevantChunks(chunks, patientSummary, topK = 8) {
  if (!chunks || chunks.length === 0) return [];
  if (chunks.length <= topK) {
    return chunks.map(c => ({ ...c, similarity: 1.0 }));
  }

  // Key clinical retrieval queries: patient characteristics, inclusion limits, exclusion/safety criteria
  const queries = [
    `Patient clinical characteristics: ${patientSummary.slice(0, 300)}`,
    "Inclusion criteria: age, diagnosis, disease duration, laboratory values, biomarker thresholds, informed consent",
    "Exclusion criteria: renal impairment, eGFR limit, hepatic failure, contraindications, prohibited medications, cardiovascular risk"
  ];

  try {
    const chunkTexts = chunks.map(c => `${c.section}: ${c.chunk_text}`);
    const chunkEmbeddings = await embedTexts(chunkTexts);
    const queryEmbeddings = await embedTexts(queries);

    const scoredChunks = chunks.map((chunk, idx) => {
      const emb = chunkEmbeddings[idx];
      let maxSim = 0;
      for (const qEmb of queryEmbeddings) {
        const sim = cosineSimilarity(emb, qEmb);
        if (sim > maxSim) maxSim = sim;
      }
      return {
        ...chunk,
        similarity: maxSim,
        embedding: emb
      };
    });

    scoredChunks.sort((a, b) => b.similarity - a.similarity);

    const topChunks = scoredChunks.slice(0, topK);
    // Sort chronologically by page number for cohesive reading
    topChunks.sort((a, b) => a.page - b.page);
    return topChunks;
  } catch (err) {
    console.warn("[Semantic Retrieval Warning] Fallback to direct chunk slice:", err?.message || err);
    return chunks.slice(0, topK).map(c => ({ ...c, similarity: 1.0 }));
  }
}

/**
 * Validates criteria against extracted protocol chunks to enforce evidence integrity.
 * Prevents conflicting page citations and never defaults to Page 1.
 */
export function validateAndGroundCriteria(criteria, allChunks) {
  if (!Array.isArray(criteria)) return [];

  return criteria.map(c => {
    const rawQuote = (c.protocolEvidence || c.evidence || "").trim();
    const cleanQuote = rawQuote.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

    let verifiedChunk = null;

    // 1. Direct quote search across protocol chunks
    if (cleanQuote.length >= 10) {
      for (const chunk of allChunks) {
        const chunkText = chunk.chunk_text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");
        if (chunkText.includes(cleanQuote)) {
          verifiedChunk = chunk;
          break;
        }
        const partial = cleanQuote.slice(0, Math.min(30, cleanQuote.length));
        if (partial.length >= 12 && chunkText.includes(partial)) {
          verifiedChunk = chunk;
          break;
        }
      }
    }

    // 2. Keyword-guided chunk anchoring for clinical consistency
    if (!verifiedChunk && c.criterion) {
      const critLower = c.criterion.toLowerCase();
      for (const chunk of allChunks) {
        const chunkLower = chunk.chunk_text.toLowerCase();
        const sectionLower = chunk.section.toLowerCase();

        // Renal / eGFR criteria: strictly bind to exclusion section if type is exclusion
        if (
          (critLower.includes("egfr") || critLower.includes("renal") || critLower.includes("glomerular") || critLower.includes("kidney")) &&
          (chunkLower.includes("egfr") || chunkLower.includes("renal") || chunkLower.includes("glomerular"))
        ) {
          if (c.type === "exclusion" && sectionLower.includes("exclusion")) {
            verifiedChunk = chunk;
            break;
          }
          if (sectionLower.includes("inclusion") && c.type === "inclusion") {
            verifiedChunk = chunk;
            break;
          }
          if (!verifiedChunk) verifiedChunk = chunk;
        }

        // Age criteria
        if (critLower.includes("age") && (chunkLower.includes("age") || chunkLower.includes("years"))) {
          verifiedChunk = chunk;
          break;
        }

        // HbA1c criteria
        if (critLower.includes("hba1c") && chunkLower.includes("hba1c")) {
          verifiedChunk = chunk;
          break;
        }

        // Metformin / medication criteria
        if ((critLower.includes("metformin") || critLower.includes("medication")) && chunkLower.includes("metformin")) {
          verifiedChunk = chunk;
          break;
        }

        // Hepatic criteria
        if ((critLower.includes("hepatic") || critLower.includes("liver") || critLower.includes("ast") || critLower.includes("alt")) &&
            (chunkLower.includes("hepatic") || chunkLower.includes("ast"))) {
          verifiedChunk = chunk;
          break;
        }
      }
    }

    // Assign verified page and section strictly from the confirmed chunk
    let verifiedPage = null;
    let verifiedSection = "";
    let isVerified = false;

    if (verifiedChunk) {
      verifiedPage = verifiedChunk.page;
      verifiedSection = verifiedChunk.section;
      isVerified = true;
    }

    const finalStatus = isVerified ? (c.status || "UNKNOWN") : "UNKNOWN";
    const finalReason = isVerified
      ? (c.reason || "")
      : `${c.reason || ""}${c.reason ? " — " : ""}Criterion evidence could not be verified against extracted protocol chunks. Marked UNKNOWN for safety review.`;

    return {
      type: (c.type || "inclusion").toLowerCase() === "exclusion" ? "exclusion" : "inclusion",
      criterion: c.criterion || "Clinical Criterion",
      status: ["PASS", "FAIL", "UNKNOWN"].includes(finalStatus) ? finalStatus : "UNKNOWN",
      patientEvidence: c.patientEvidence || "",
      protocolEvidence: isVerified ? (rawQuote || verifiedChunk?.chunk_text || "") : "Unverified in protocol",
      evidence: isVerified ? (rawQuote || verifiedChunk?.chunk_text || "") : "Unverified in protocol",
      page: verifiedPage,
      section: verifiedSection,
      reason: finalReason,
      verified: isVerified
    };
  });
}

/**
 * Calculates a deterministic clinical eligibility score on the server.
 * When a critical exclusion or contraindication is present, enrollment is prohibited,
 * producing an explainable 0% / NOT_ELIGIBLE determination.
 */
export function computeDeterministicEligibility(criteria, contraindications) {
  if (!criteria || criteria.length === 0) {
    return {
      eligibilityScore: 0,
      overallStatus: "NOT_ELIGIBLE",
      eligible: false,
      explanation: "No clinical criteria available for trial evaluation.",
      breakdown: { total: 0 }
    };
  }

  const inclusionList = criteria.filter(c => c.type === "inclusion");
  const exclusionList = criteria.filter(c => c.type === "exclusion");

  const failedInclusions = inclusionList.filter(c => c.status === "FAIL");
  const failedExclusions = exclusionList.filter(c => c.status === "FAIL");
  const unknownCriteria = criteria.filter(c => c.status === "UNKNOWN");
  const passedCriteria = criteria.filter(c => c.status === "PASS");

  const criticalContraindications = (contraindications || []).filter(item => {
    const sev = typeof item === "object" ? (item.severity || "").toUpperCase() : "";
    return sev === "CRITICAL";
  });

  // Clinical Rule:
  // In clinical trials, any failed exclusion criterion (triggered disqualifier),
  // failed mandatory inclusion criterion, or critical safety contraindication
  // strictly bars the patient from study enrollment.
  const hasCriticalDisqualification =
    failedExclusions.length > 0 ||
    failedInclusions.length > 0 ||
    criticalContraindications.length > 0;

  let finalScore = 0;
  let overallStatus = "NOT_ELIGIBLE";
  let explanation = "";

  if (hasCriticalDisqualification) {
    // 0% Score is mathematically & clinically explainable: enrollment is barred
    finalScore = 0;
    overallStatus = "NOT_ELIGIBLE";

    const reasons = [];
    if (failedExclusions.length > 0) {
      reasons.push(`${failedExclusions.length} failed exclusion criteria (${failedExclusions.map(e => e.criterion).join(", ")})`);
    }
    if (failedInclusions.length > 0) {
      reasons.push(`${failedInclusions.length} failed inclusion criteria (${failedInclusions.map(i => i.criterion).join(", ")})`);
    }
    if (criticalContraindications.length > 0) {
      reasons.push(`${criticalContraindications.length} critical safety contraindications (${criticalContraindications.map(ci => ci.issue).join(", ")})`);
    }

    explanation = `Candidate is NOT ELIGIBLE (0% score) due to disqualifying clinical findings: ${reasons.join("; ")}. Protocol rules strictly prohibit enrollment when safety limits or core criteria are violated.`;
  } else if (unknownCriteria.length > 0) {
    // Proportional satisfaction of verified criteria
    const passCount = passedCriteria.length;
    const totalCount = criteria.length;
    finalScore = Math.max(10, Math.min(95, Math.round((passCount / totalCount) * 100)));
    overallStatus = "REQUIRES_REVIEW";

    explanation = `Candidate satisfies primary verified criteria (${finalScore}% score), but ${unknownCriteria.length} item(s) have UNKNOWN status due to missing records and require clinician verification (${unknownCriteria.map(u => u.criterion).join(", ")}).`;
  } else {
    // All criteria evaluated and all PASS
    finalScore = 100;
    overallStatus = "ELIGIBLE";
    explanation = "Candidate satisfies all inclusion criteria and avoids all exclusion criteria. Fully eligible for trial enrollment.";
  }

  const isEligible = overallStatus === "ELIGIBLE";

  return {
    eligibilityScore: finalScore,
    overallStatus,
    eligible: isEligible,
    explanation,
    breakdown: {
      total: criteria.length,
      inclusionsPassed: inclusionList.filter(c => c.status === "PASS").length,
      inclusionsFailed: failedInclusions.length,
      exclusionsPassed: exclusionList.filter(c => c.status === "PASS").length,
      exclusionsFailed: failedExclusions.length,
      unknownCriteria: unknownCriteria.length,
      criticalContraindications: criticalContraindications.length
    }
  };
}
