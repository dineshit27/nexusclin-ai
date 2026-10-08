"use client";

import { useEffect, useRef, useState } from "react";

const samplePatient = `Age: 54
Sex: Female
Diagnosis: Type 2 diabetes mellitus
HbA1c: 7.4%
eGFR: 42 mL/min/1.73m²
Medical history: Hypertension
Current medications: Metformin, amlodipine`;

const MAX_FILE_SIZE_MB = 15;
const MAX_PATIENT_CHARS = 8000;

// Map common server error patterns to friendly messages
function friendlyError(msg) {
  if (!msg) return "An unexpected error occurred. Please try again.";
  const lower = msg.toLowerCase();
  if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("high demand")) {
    return "The AI service is temporarily at capacity. Please wait 30 seconds and try again.";
  }
  if (lower.includes("quota") || lower.includes("rate limit")) {
    return "API quota exceeded. Please try again in a few minutes.";
  }
  if (lower.includes("pdf") || lower.includes("extract")) {
    return "Could not read the PDF. Ensure it is a text-based PDF and not image-only or encrypted.";
  }
  return msg;
}

const STEPS = [
  "Extracting PDF pages…",
  "Chunking protocol sections…",
  "Generating semantic embeddings…",
  "Retrieving evidence via pgvector…",
  "Reasoning with Gemini…",
  "Scoring deterministically…",
];

function StatusBadge({ status }) {
  if (status === "PASS") return <span className="pass">PASS</span>;
  if (status === "FAIL") return <span className="fail">FAIL</span>;
  return <span className="unknown">UNKNOWN</span>;
}

function CriterionDot({ status }) {
  if (status === "PASS") return <div className="dot passdot">✓</div>;
  if (status === "FAIL") return <div className="dot faildot">✗</div>;
  return <div className="dot unknowndot">?</div>;
}

function Results({ result }) {
  const criteria = result.criteria || [];
  const contraindications = result.contraindications || [];
  const stats = result.retrievalStats;

  let decisionClass = "decision warn";
  let decisionText = "✗ Not Eligible";
  if (result.overallStatus === "ELIGIBLE" || result.eligible) {
    decisionClass = "decision good";
    decisionText = "✓ Eligible";
  } else if (result.overallStatus === "REQUIRES_REVIEW") {
    decisionClass = "decision warn";
    decisionText = "⚠ Requires Review";
  } else {
    decisionClass = "decision bad";
    decisionText = "✗ Not Eligible";
  }

  return (
    <section className="results">
      <div className="score-card">
        <div className="panel-title"><span>04</span> Eligibility decision</div>
        <div className="score">
          {result.eligibilityScore ?? result.overallScore ?? 0}
          <small>%</small>
        </div>
        <div className={decisionClass}>
          {decisionText}
        </div>
        <p>{result.summary}</p>

        {result.explanation && result.explanation !== result.summary && (
          <div style={{ marginTop: "12px", padding: "10px", background: result.eligible ? "#e6f4ea" : result.overallStatus === "REQUIRES_REVIEW" ? "#fff7e0" : "#fce8e6", border: "2px solid #000", fontSize: "12px", lineHeight: "1.4" }}>
            <strong>Determination:</strong> {result.explanation}
          </div>
        )}

        {result.deterministicBreakdown && (
          <div style={{ marginTop: "12px", fontSize: "11px", color: "#444", display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <span style={{ border: "1px solid #777", padding: "2px 6px", background: "#fff", fontWeight: "600" }}>
              Inclusions Passed: {result.deterministicBreakdown.inclusionsPassed}
            </span>
            <span style={{ border: "1px solid #777", padding: "2px 6px", background: "#fff", fontWeight: "600" }}>
              Exclusions Avoided: {result.deterministicBreakdown.exclusionsPassed}
            </span>
            {result.deterministicBreakdown.exclusionsFailed > 0 && (
              <span style={{ border: "2px solid #c00", color: "#c00", padding: "2px 6px", background: "#fff", fontWeight: "700" }}>
                Exclusions Triggered: {result.deterministicBreakdown.exclusionsFailed}
              </span>
            )}
            {result.deterministicBreakdown.unknownCriteria > 0 && (
              <span style={{ border: "1px solid #777", padding: "2px 6px", background: "#fff" }}>
                Pending Review: {result.deterministicBreakdown.unknownCriteria}
              </span>
            )}
          </div>
        )}

        {stats && (
          <div style={{ marginTop: "16px", padding: "8px 12px", background: "#f0f4f8", border: "2px solid #000", fontSize: "12px", fontWeight: "600" }}>
            🔍 Grounded via {stats.retrievedChunksCount} pgvector chunks &bull; {stats.modelUsed}
          </div>
        )}

        {contraindications.length > 0 && (
          <div className="contra" style={{ marginTop: "20px" }}>
            <strong>⚠ Critical contraindications</strong>
            <ul>
              {contraindications.map((x, i) => {
                const text = typeof x === "string"
                  ? x
                  : `${x.issue || x.criterion || "Contraindication"}${x.severity ? ` [${x.severity}]` : ""}`;
                const cite = typeof x !== "string" && x.page
                  ? ` — Page ${x.page}${x.section ? `, §${x.section}` : ""}`
                  : typeof x !== "string" && x.page === null
                  ? " — Page: UNKNOWN (unverified)"
                  : "";
                return <li key={i}>{text}{cite}</li>;
              })}
            </ul>
          </div>
        )}
      </div>

      <div className="panel evidence">
        <div className="panel-title">
          <span>05</span> Criteria breakdown
          {criteria.length > 0 && (
            <span style={{ marginLeft: "auto", fontSize: "12px", color: "#666", display: "flex", gap: "8px" }}>
              <span className="pass" style={{ fontSize: "11px" }}>{criteria.filter(c => c.status === "PASS").length} PASS</span>
              <span className="fail" style={{ fontSize: "11px" }}>{criteria.filter(c => c.status === "FAIL").length} FAIL</span>
              <span className="unknown" style={{ fontSize: "11px" }}>{criteria.filter(c => c.status === "UNKNOWN").length} ?</span>
            </span>
          )}
        </div>

        {criteria.length === 0 && (
          <div className="empty">No criteria returned by the AI analysis.</div>
        )}

        {criteria.map((c, i) => (
          <div className="criterion" key={i}>
            <CriterionDot status={c.status} />
            <div className="criterion-body">
              <div className="criterion-head">
                <strong>{c.criterion}</strong>
                <div style={{ display: "flex", gap: "6px", alignItems: "center", flexShrink: 0 }}>
                  <span className={`type-badge ${c.type === "exclusion" ? "type-exclusion" : "type-inclusion"}`}>
                    {c.type || "inclusion"}
                  </span>
                  <StatusBadge status={c.status} />
                </div>
              </div>
              <p>{c.reason}</p>
              {(c.protocolEvidence || c.evidence) && (
                <blockquote>
                  &ldquo;{c.protocolEvidence || c.evidence}&rdquo;
                  <small>
                    Protocol — {c.page ? `Page ${c.page}` : "Page: UNKNOWN (Unverified)"}
                    {c.section ? `, §${c.section}` : ""}
                    {c.verified === false && " ⚠ Unverified quote"}
                  </small>
                </blockquote>
              )}
              {c.patientEvidence && (
                <blockquote style={{ borderLeftColor: "#999", marginTop: "6px" }}>
                  <span style={{ color: "#555", fontStyle: "normal" }}>Patient: </span>{c.patientEvidence}
                </blockquote>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState("");
  const [patient, setPatient] = useState(samplePatient);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [stepIdx, setStepIdx] = useState(0);
  const inFlightRef = useRef(false);
  const stepTimerRef = useRef(null);

  async function loadHistory() {
    try {
      const r = await fetch("/api/history");
      const data = await r.json();
      if (data.ok && Array.isArray(data.items) && data.items.length > 0) {
        setHistory(data.items);
      }
    } catch {}
  }

  useEffect(() => { loadHistory(); }, []);

  // Cycle through progress step labels during loading
  useEffect(() => {
    if (loading) {
      setStepIdx(0);
      let i = 0;
      stepTimerRef.current = setInterval(() => {
        i = Math.min(i + 1, STEPS.length - 1);
        setStepIdx(i);
      }, 8000);
    } else {
      clearInterval(stepTimerRef.current);
    }
    return () => clearInterval(stepTimerRef.current);
  }, [loading]);

  function handleFileChange(e) {
    const picked = e.target.files?.[0] || null;
    setFileError("");
    if (!picked) { setFile(null); return; }

    if (picked.type !== "application/pdf") {
      setFileError("Only PDF files are accepted.");
      setFile(null);
      e.target.value = "";
      return;
    }
    if (picked.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      setFileError(`File is too large (${(picked.size / 1024 / 1024).toFixed(1)} MB). Max ${MAX_FILE_SIZE_MB} MB.`);
      setFile(null);
      e.target.value = "";
      return;
    }
    if (picked.size < 512) {
      setFileError("The PDF appears to be empty. Please upload a valid protocol file.");
      setFile(null);
      e.target.value = "";
      return;
    }

    setFile(picked);
  }

  async function analyze() {
    if (inFlightRef.current) return; // Prevent duplicate submissions
    if (!file) return setMessage("Upload a clinical trial protocol PDF first.");
    if (!patient.trim()) return setMessage("Enter a synthetic patient summary.");
    if (patient.length > MAX_PATIENT_CHARS) return setMessage(`Patient summary is too long (${patient.length} chars). Max ${MAX_PATIENT_CHARS}.`);

    inFlightRef.current = true;
    setLoading(true);
    setMessage("");
    setResult(null);

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("patient", patient);
      const r = await fetch("/api/analyze", { method: "POST", body: form });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Analysis failed.");
      setResult(data.analysis);

      // Optimistic cohort update for live demo responsiveness
      const firstLine = patient.split("\n")[0] || "Synthetic Patient";
      const pLabel = firstLine.length > 5 && firstLine.length < 40 ? firstLine : "Synthetic Patient";
      setHistory(prev => [
        {
          id: `opt-${Date.now()}`,
          patient_label: pLabel,
          score: data.analysis.eligibilityScore,
          eligible: data.analysis.eligible,
          overall_status: data.analysis.overallStatus,
          trial_name: file.name || "Clinical Trial Protocol"
        },
        ...prev
      ]);

      // Refresh from DB after a brief delay (avoid race with DB write)
      setTimeout(loadHistory, 2000);
    } catch (e) {
      setMessage(friendlyError(e.message));
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }

  const charCount = patient.length;
  const charWarning = charCount > MAX_PATIENT_CHARS * 0.85;

  return (
    <main>
      {/* ── Top bar ── */}
      <header className="topbar">
        <div>
          <div className="eyebrow">Clinical Research Intelligence</div>
          <h1>Nexus<span>Clin</span></h1>
          <p>Evidence-grounded clinical trial eligibility matching.</p>
        </div>
        <div className="status">
          <span></span> Gemini + pgvector Pipeline
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="hero">
        <div>
          <div className="badge">AI-Assisted Eligibility Engine</div>
          <h2>Find the right trial candidate<br />without reading every page manually.</h2>
          <p>Upload a trial protocol PDF, add a synthetic patient summary, and get a traceable eligibility decision with source-grounded evidence and exact page citations.</p>
        </div>
        <div className="hero-stat">
          <strong>3 min</strong>
          <span>live verification flow</span>
        </div>
      </section>

      {/* ── Input panels ── */}
      <section className="grid">
        <div className="panel">
          <div className="panel-title"><span>01</span> Trial protocol</div>
          <label className={`upload${file ? " upload-ready" : ""}`}>
            <input
              id="protocol-pdf-input"
              type="file"
              accept="application/pdf"
              onChange={handleFileChange}
              disabled={loading}
            />
            <div className="upload-icon">{file ? "✓" : "↑"}</div>
            <strong>{file ? file.name : "Drop or choose a PDF"}</strong>
            <small>
              {file
                ? `${(file.size / 1024).toFixed(0)} KB · PDF ready`
                : `Clinical trial protocol · PDF · Max ${MAX_FILE_SIZE_MB} MB`}
            </small>
          </label>
          {fileError && <div className="error" style={{ marginTop: "10px" }}>⚠ {fileError}</div>}
        </div>

        <div className="panel">
          <div className="panel-title"><span>02</span> Synthetic patient</div>
          <textarea
            id="patient-summary-input"
            value={patient}
            onChange={e => setPatient(e.target.value)}
            placeholder="Paste patient summary here…"
            disabled={loading}
            maxLength={MAX_PATIENT_CHARS}
          />
          <div style={{ fontSize: "11px", color: charWarning ? "#b51c1c" : "#888", textAlign: "right", marginTop: "4px" }}>
            {charCount} / {MAX_PATIENT_CHARS} characters
          </div>
          <button
            id="analyze-btn"
            className="primary"
            onClick={analyze}
            disabled={loading || !!fileError}
          >
            {loading ? (
              <><span className="spinner" />{STEPS[stepIdx]}</>
            ) : (
              "Analyze eligibility →"
            )}
          </button>
          {message && <div className="error" role="alert">⚠ {message}</div>}
        </div>
      </section>

      {/* ── Results ── */}
      {result && <Results result={result} />}

      {/* ── Patient cohort ── */}
      <section className="panel history">
        <div className="panel-title"><span>03</span> Patient cohort</div>
        {history.length === 0
          ? <div className="empty">No saved analyses yet. Your first analysis will appear here.</div>
          : (
            <div className="table">
              <div className="tr th">
                <span>Patient</span>
                <span>Score</span>
                <span>Status</span>
                <span>Trial</span>
              </div>
              {history.map((x, i) => (
                <div className="tr" key={x.id || i}>
                  <span>{x.patient_label || `Synthetic Patient ${i + 1}`}</span>
                  <b>{x.score}%</b>
                  <span className={x.eligible ? "pass" : x.overall_status === "REQUIRES_REVIEW" ? "unknown" : "fail"}>
                    {x.eligible ? "Eligible" : (x.overall_status === "REQUIRES_REVIEW" ? "Review" : "Not Eligible")}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {x.trial_name || "Protocol"}
                  </span>
                </div>
              ))}
            </div>
          )
        }
      </section>

      <footer>
        NexusClin &bull; Powered by Google Gemini &bull; pgvector semantic retrieval &bull; Demo uses synthetic patient information only.
      </footer>
    </main>
  );
}
