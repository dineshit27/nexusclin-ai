/**
 * NexusClin Clinical Protocol Intelligence
 * Page-aware extraction, semantic chunking, grounding verification, and deterministic scoring.
 */

import pdf from "pdf-parse";
import { embedTexts, cosineSimilarity } from "./gemini.js";

/**
 * Extracts text from PDF with page numbers preserved.
 */
export async function parsePdfByPages(buffer) {
  const pages = [];
  const options = {
    pagerender: function (pageData) {
      return pageData.getTextContent({ normalizeWhitespace: true }).then(function (textContent) {
        let lastY, text = "";
        for (let item of textContent.items) {
          if (!item.str) continue;
          if (lastY === undefined || Math.abs(lastY - item.transform[5]) < 2) {
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
    console.error("PDF page extraction fallback error:", e);
    const parsed = await pdf(buffer);
    const clean = (parsed.text || "").trim();
    return clean ? [{ page: 1, text: clean }] : [];
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
        // Flush existing paragraph
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

      // Split chunks around ~450-700 characters at sentence boundaries
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
  if (chunks.length <= topK) return chunks;

  // Formulate key clinical retrieval queries from patient attributes & clinical trial domains
  const queries = [
    `Patient clinical characteristics: ${patientSummary.slice(0, 300)}`,
    "Inclusion criteria: age, diagnosis, disease duration, laboratory values, biomarker thresholds, informed consent",
    "Exclusion criteria: renal impairment, hepatic failure, contraindications, prohibited medications, cardiovascular risk"
  ];

  try {
    // Generate embeddings for protocol chunks and queries
    const chunkTexts = chunks.map(c => `${c.section}: ${c.chunk_text}`);
    const chunkEmbeddings = await embedTexts(chunkTexts);
    const queryEmbeddings = await embedTexts(queries);

    // Compute max cosine similarity for each chunk against any of the clinical queries
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

    // Sort descending by similarity
    scoredChunks.sort((a, b) => b.similarity - a.similarity);

    // Take topK, then re-sort by page number for logical protocol reading
    const topChunks = scoredChunks.slice(0, topK);
    topChunks.sort((a, b) => a.page - b.page);
    return topChunks;
  } catch (err) {
    console.warn("[Semantic Retrieval Warning] Fallback to direct chunk slice:", err?.message || err);
    return chunks.slice(0, topK);
  }
}

/**
 * Validates AI criteria against extracted protocol chunks to enforce evidence integrity.
 * If protocolEvidence or page cannot be verified from the chunks, status is set to UNKNOWN and page is null.
 */
export function validateAndGroundCriteria(criteria, allChunks) {
  if (!Array.isArray(criteria)) return [];

  return criteria.map(c => {
    const rawQuote = (c.protocolEvidence || c.evidence || "").trim();
    const cleanQuote = rawQuote.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

    let verifiedChunk = null;

    if (cleanQuote.length >= 10) {
      // Find chunk containing this quote or significant overlap
      for (const chunk of allChunks) {
        const chunkText = chunk.chunk_text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");
        if (chunkText.includes(cleanQuote)) {
          verifiedChunk = chunk;
          break;
        }
        // Check partial overlap (first 30 chars or 60% of quote)
        const partial = cleanQuote.slice(0, Math.min(40, cleanQuote.length));
        if (partial.length >= 15 && chunkText.includes(partial)) {
          verifiedChunk = chunk;
          break;
        }
      }
    }

    // Determine verified page and section
    let verifiedPage = null;
    let verifiedSection = c.section || "";
    let isVerified = false;

    if (verifiedChunk) {
      verifiedPage = verifiedChunk.page;
      verifiedSection = verifiedChunk.section || c.section || "";
      isVerified = true;
    } else {
      // If claimed page matches an actual chunk on that page with criterion keyword
      const claimedPage = typeof c.page === "number" ? c.page : parseInt(c.page, 10);
      if (claimedPage && allChunks.some(ch => ch.page === claimedPage)) {
        const pageChunks = allChunks.filter(ch => ch.page === claimedPage);
        const critWords = (c.criterion || "").toLowerCase().split(" ").filter(w => w.length > 4);
        const matchesPage = pageChunks.some(ch =>
          critWords.some(w => ch.chunk_text.toLowerCase().includes(w))
        );
        if (matchesPage) {
          verifiedPage = claimedPage;
          isVerified = true;
        }
      }
    }

    // Evidence integrity enforcement:
    // If quote cannot be verified from protocol chunks, do NOT invent or default to Page 1.
    const finalStatus = isVerified ? (c.status || "UNKNOWN") : "UNKNOWN";
    const finalReason = isVerified
      ? (c.reason || "")
      : `${c.reason || ""}${c.reason ? " — " : ""}Criterion evidence could not be verified against the extracted protocol pages. Marked UNKNOWN for clinician review.`;

    return {
      type: (c.type || "inclusion").toLowerCase() === "exclusion" ? "exclusion" : "inclusion",
      criterion: c.criterion || "Clinical Criterion",
      status: ["PASS", "FAIL", "UNKNOWN"].includes(finalStatus) ? finalStatus : "UNKNOWN",
      patientEvidence: c.patientEvidence || "",
      protocolEvidence: rawQuote || (isVerified ? "" : "Unverified in protocol"),
      evidence: rawQuote,
      page: isVerified ? verifiedPage : null,
      section: isVerified ? verifiedSection : "",
      reason: finalReason,
      verified: isVerified
    };
  });
}

/**
 * Calculates a deterministic clinical eligibility score on the server.
 * Does NOT blindly trust LLM hallucinated score.
 */
export function computeDeterministicEligibility(criteria, contraindications) {
  if (!criteria || criteria.length === 0) {
    return {
      eligibilityScore: 0,
      overallStatus: "NOT_ELIGIBLE",
      eligible: false,
      breakdown: { total: 0 }
    };
  }

  const inclusionList = criteria.filter(c => c.type === "inclusion");
  const exclusionList = criteria.filter(c => c.type === "exclusion");

  // Inclusion Scoring: PASS = 1.0, UNKNOWN = 0.25, FAIL = 0.0
  let inclusionScore = 0;
  let failedInclusions = 0;
  for (const c of inclusionList) {
    if (c.status === "PASS") inclusionScore += 1.0;
    else if (c.status === "UNKNOWN") inclusionScore += 0.25;
    else if (c.status === "FAIL") failedInclusions++;
  }

  // Exclusion Scoring: PASS (patient avoided exclusion) = 1.0, UNKNOWN = 0.5, FAIL (patient triggered exclusion) = 0.0
  let exclusionScore = 0;
  let failedExclusions = 0;
  for (const c of exclusionList) {
    if (c.status === "PASS") exclusionScore += 1.0;
    else if (c.status === "UNKNOWN") exclusionScore += 0.5;
    else if (c.status === "FAIL") failedExclusions++;
  }

  const totalCriteria = criteria.length;
  const rawRatio = ((inclusionScore + exclusionScore) / totalCriteria) * 100;

  // Critical contraindications check
  const criticalContraindications = (contraindications || []).filter(item => {
    const sev = typeof item === "object" ? (item.severity || "").toUpperCase() : "";
    return sev === "CRITICAL";
  });

  // Severe deterministic deductions for disqualified criteria
  const penalty = (failedExclusions * 35) + (failedInclusions * 30) + (criticalContraindications.length * 30);
  const finalScore = Math.max(0, Math.min(100, Math.round(rawRatio - penalty)));

  // Clinical Rule: Any failed exclusion, critical contraindication, or failed mandatory inclusion
  // means the patient is definitively NOT ELIGIBLE for the clinical trial.
  const isDisqualified = failedExclusions > 0 || failedInclusions > 0 || criticalContraindications.length > 0;
  const isEligible = !isDisqualified && finalScore >= 80;

  let overallStatus = "NOT_ELIGIBLE";
  if (isEligible) {
    overallStatus = "ELIGIBLE";
  } else if (!isDisqualified && finalScore >= 60) {
    overallStatus = "REQUIRES_REVIEW";
  }

  return {
    eligibilityScore: finalScore,
    overallStatus,
    eligible: isEligible,
    breakdown: {
      total: totalCriteria,
      inclusionsPassed: inclusionList.filter(c => c.status === "PASS").length,
      inclusionsFailed: failedInclusions,
      exclusionsPassed: exclusionList.filter(c => c.status === "PASS").length,
      exclusionsFailed: failedExclusions,
      unknownCriteria: criteria.filter(c => c.status === "UNKNOWN").length,
      criticalContraindications: criticalContraindications.length
    }
  };
}
