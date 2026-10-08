 "use client";

import { useEffect, useState } from "react";

const samplePatient = `Age: 54
Sex: Female
Diagnosis: Type 2 diabetes mellitus
HbA1c: 7.4%
eGFR: 42 mL/min/1.73m²
Medical history: hypertension
Current medications: metformin, amlodipine`;

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
    if (!file) return setMessage("Upload a clinical trial PDF first.");
    if (!patient.trim()) return setMessage("Enter a patient summary.");
    setLoading(true); setMessage(""); setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("patient", patient);
      const r = await fetch("/api/analyze", { method: "POST", body: form });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Analysis failed");
      setResult(data.analysis);
      loadHistory();
    } catch (e) {
      setMessage(e.message);
    } finally { setLoading(false); }
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <div className="eyebrow">CLINICAL RESEARCH INTELLIGENCE</div>
          <h1>Nexus<span>Clin</span></h1>
          <p>Evidence-grounded clinical trial eligibility matching.</p>
        </div>
        <div className="status"><span></span> Secure analysis workspace</div>
      </header>

      <section className="hero">
        <div>
          <div className="badge">AI-ASSISTED ELIGIBILITY ENGINE</div>
          <h2>Find the right trial candidate<br/>without reading every page manually.</h2>
          <p>Upload a trial protocol, add a synthetic patient summary, and get a traceable eligibility decision with source evidence.</p>
        </div>
        <div className="hero-stat"><strong>3 min</strong><span>live verification flow</span></div>
      </section>

      <section className="grid">
        <div className="panel">
          <div className="panel-title"><span>01</span> Trial protocol</div>
          <label className="upload">
            <input type="file" accept="application/pdf" onChange={e => setFile(e.target.files?.[0] || null)} />
            <div className="upload-icon">↑</div>
            <strong>{file ? file.name : "Drop or choose a PDF"}</strong>
            <small>Clinical trial protocol • PDF</small>
          </label>
        </div>

        <div className="panel">
          <div className="panel-title"><span>02</span> Synthetic patient</div>
          <textarea value={patient} onChange={e => setPatient(e.target.value)} />
          <button className="primary" onClick={analyze} disabled={loading}>
            {loading ? "Analyzing evidence…" : "Analyze eligibility →"}
          </button>
          {message && <div className="error">{message}</div>}
        </div>
      </section>

      {result && <Results result={result} />}

      <section className="panel history">
        <div className="panel-title"><span>03</span> Patient cohort</div>
        {history.length === 0 ? <div className="empty">No saved analyses yet. Your first analysis will appear here.</div> :
          <div className="table">
            <div className="tr th"><span>Patient</span><span>Score</span><span>Status</span><span>Trial</span></div>
            {history.map((x, i) => <div className="tr" key={x.id || i}>
              <span>{x.patient_label || `Synthetic Patient ${i+1}`}</span>
              <b>{x.score}%</b>
              <span className={x.eligible ? "pass" : "fail"}>{x.eligible ? "ELIGIBLE" : "REVIEW"}</span>
              <span>{x.trial_name || "Protocol"}</span>
            </div>)}
          </div>}
      </section>

      <footer>NexusClin • Demo uses synthetic patient information only.</footer>
    </main>
  );
}

function Results({ result }) {
  return <section className="results">
    <div className="score-card">
      <div className="panel-title"><span>04</span> Eligibility decision</div>
      <div className="score">{result.overallScore}<small>%</small></div>
      <div className={result.eligible ? "decision good" : "decision warn"}>{result.eligible ? "ELIGIBLE" : "NOT ELIGIBLE / REVIEW"}</div>
      <p>{result.summary}</p>
    </div>
    <div className="panel evidence">
      <div className="panel-title">Criteria breakdown</div>
      {(result.criteria || []).map((c, i) => <div className="criterion" key={i}>
        <div className={c.status === "PASS" ? "dot passdot" : "dot faildot"}>{c.status === "PASS" ? "✓" : "!"}</div>
        <div className="criterion-body">
          <div className="criterion-head"><strong>{c.criterion}</strong><span className={c.status === "PASS" ? "pass" : "fail"}>{c.status}</span></div>
          <p>{c.reason}</p>
          <blockquote>“{c.evidence || c.protocolEvidence || "N/A"}” <small>Page {c.page ?? "—"}{c.section ? `, Sec ${c.section}` : ""}</small></blockquote>
        </div>
      </div>)}
      {(result.contraindications || []).length > 0 && <div className="contra">
        <strong>⚠ Critical contraindications</strong>
        <ul>{result.contraindications.map((x, i) => (
          <li key={i}>
            {typeof x === "string" ? x : `${x.issue || x.criterion || JSON.stringify(x)}${x.severity ? ` [${x.severity}]` : ''}${x.page ? ` (Page ${x.page}${x.section ? `, Sec ${x.section}` : ''})` : ''}`}
          </li>
        ))}</ul>
      </div>}
    </div>
  </section>
}
