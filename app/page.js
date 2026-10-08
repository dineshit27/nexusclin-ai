"use client";

import { useEffect, useState } from "react";

const samplePatient = `Age: 54
Sex: Female
Diagnosis: Type 2 diabetes mellitus
HbA1c: 7.4%
eGFR: 42 mL/min/1.73m²
Medical history: Hypertension
Current medications: Metformin, amlodipine`;

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

  return (
    <section className="results">
      <div className="score-card">
        <div className="panel-title"><span>04</span> Eligibility decision</div>
        <div className="score">
          {result.eligibilityScore ?? result.overallScore ?? 0}
          <small>%</small>
        </div>
        <div className={result.eligible ? "decision good" : "decision warn"}>
          {result.eligible ? "✓ Eligible" : "✗ Not Eligible"}
        </div>
        <p>{result.summary}</p>

        {contraindications.length > 0 && (
          <div className="contra" style={{ marginTop: "20px" }}>
            <strong>⚠ Critical contraindications</strong>
            <ul>
              {contraindications.map((x, i) => {
                const text = typeof x === "string"
                  ? x
                  : `${x.issue || x.criterion || "Contraindication"}${x.severity ? ` [${x.severity}]` : ""}`;
                const cite = typeof x !== "string" && x.page
                  ? ` (Page ${x.page}${x.section ? `, Sec ${x.section}` : ""})`
                  : "";
                return <li key={i}>{text}{cite}</li>;
              })}
            </ul>
          </div>
        )}
      </div>

      <div className="panel evidence">
        <div className="panel-title"><span>05</span> Criteria breakdown</div>

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
                    Protocol — Page {c.page ?? "—"}
                    {c.section ? `, §${c.section}` : ""}
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
  const [patient, setPatient] = useState(samplePatient);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function loadHistory() {
    try {
      const r = await fetch("/api/history");
      const data = await r.json();
      if (data.ok) setHistory(data.items || []);
    } catch {}
  }

  useEffect(() => { loadHistory(); }, []);

  async function analyze() {
    if (!file) return setMessage("Upload a clinical trial protocol PDF first.");
    if (!patient.trim()) return setMessage("Enter a synthetic patient summary.");
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
      loadHistory();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  }

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
          <span></span> Secure analysis workspace
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
          <label className="upload">
            <input
              type="file"
              accept="application/pdf"
              onChange={e => setFile(e.target.files?.[0] || null)}
            />
            <div className="upload-icon">↑</div>
            <strong>{file ? file.name : "Drop or choose a PDF"}</strong>
            <small>Clinical trial protocol • PDF format</small>
          </label>
        </div>

        <div className="panel">
          <div className="panel-title"><span>02</span> Synthetic patient</div>
          <textarea
            value={patient}
            onChange={e => setPatient(e.target.value)}
            placeholder="Paste patient summary here…"
          />
          <button className="primary" onClick={analyze} disabled={loading}>
            {loading ? (
              <><span className="spinner" />Analyzing evidence…</>
            ) : (
              "Analyze eligibility →"
            )}
          </button>
          {message && <div className="error">⚠ {message}</div>}
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
                  <span className={x.eligible ? "pass" : "fail"}>
                    {x.eligible ? "Eligible" : "Review"}
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
        NexusClin &bull; Powered by Google Gemini &bull; Demo uses synthetic patient information only.
      </footer>
    </main>
  );
}
