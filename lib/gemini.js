/**
 * NexusClin Gemini API Integration
 * Supported models, automated capacity fallback, and batch embeddings.
 */

const CANDIDATE_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest"
];

const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSION = 1536;

export function isTemporaryCapacityError(status, message) {
  // Clear HTTP status codes for capacity/rate limits/transient gateway issues
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
    "capacity"
  ];

  return capacityKeywords.some(kw => msg.includes(kw));
}

/**
 * Robust JSON extraction from Gemini's candidate output.
 */
export function parseJsonFromCandidate(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Gemini returned empty text output.");
  }

  // Strip code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Attempt substring extraction if extraneous text surrounded JSON
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error(`Failed to parse JSON response: ${e.message}`);
  }
}

/**
 * Call Gemini generateContent with real fallback across distinct models.
 */
export async function callGeminiWithFallback(promptText, systemInstruction = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }

  let lastError = null;

  for (let i = 0; i < CANDIDATE_MODELS.length; i++) {
    const model = CANDIDATE_MODELS[i];
    const isLastModel = i === CANDIDATE_MODELS.length - 1;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const bodyPayload = {
      contents: [
        {
          role: "user",
          parts: [{ text: promptText }]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1
      }
    };

    if (systemInstruction) {
      bodyPayload.systemInstruction = {
        parts: [{ text: systemInstruction }]
      };
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(bodyPayload)
      });

      if (!res.ok) {
        const errorText = await res.text();
        let errMessage = `Gemini API HTTP ${res.status}`;
        try {
          const errJson = JSON.parse(errorText);
          if (errJson.error?.message) {
            errMessage = errJson.error.message;
          }
        } catch {}

        if (!isLastModel && isTemporaryCapacityError(res.status, errMessage)) {
          console.warn(`[Gemini Fallback] Model ${model} returned temporary capacity error (${res.status}: ${errMessage}). Retrying with fallback model ${CANDIDATE_MODELS[i + 1]}...`);
          lastError = new Error(`${model} capacity error: ${errMessage}`);
          continue;
        }

        throw new Error(errMessage);
      }

      const data = await res.json();
      const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!candidateText) {
        throw new Error(`Gemini model ${model} returned no content parts.`);
      }

      const parsed = parseJsonFromCandidate(candidateText);
      return {
        data: parsed,
        modelUsed: model
      };
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

/**
 * Generate semantic vector embeddings for a list of text strings using gemini-embedding-001.
 * Dimensions: 1536 (matches Supabase pgvector vector(1536)).
 */
export async function embedTexts(texts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }

  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const BATCH_SIZE = 25;
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`;

    const requests = batch.map(text => ({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text: text.slice(0, 2048) }] },
      outputDimensionality: EMBEDDING_DIMENSION
    }));

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[Gemini Embeddings] Batch ${i / BATCH_SIZE + 1} failed (${res.status}): ${errText}`);
      // Return zero vectors for this batch if embedding fails
      batch.forEach(() => allEmbeddings.push(new Array(EMBEDDING_DIMENSION).fill(0)));
      continue;
    }

    const json = await res.json();
    const batchResults = json.embeddings || [];
    for (let j = 0; j < batch.length; j++) {
      const vals = batchResults[j]?.values;
      if (Array.isArray(vals) && vals.length > 0) {
        allEmbeddings.push(vals);
      } else {
        allEmbeddings.push(new Array(EMBEDDING_DIMENSION).fill(0));
      }
    }
  }

  return allEmbeddings;
}

/**
 * Fast cosine similarity between two numeric vectors.
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
