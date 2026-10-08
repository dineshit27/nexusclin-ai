import fs from "fs";

async function testCandidate(label, patientSummary) {
  const fileBuffer = fs.readFileSync("sample-protocol.pdf");
  const blob = new Blob([fileBuffer], { type: "application/pdf" });
  const form = new FormData();
  form.append("file", blob, "sample-protocol.pdf");
  form.append("patient", patientSummary);

  console.log("\n=============================================");
  console.log("Testing: " + label);
  console.log("=============================================");

  const res = await fetch("http://localhost:3000/api/analyze", {
    method: "POST",
    body: form
  });

  console.log("HTTP Status:", res.status);
  const data = await res.json();
  if (!data.ok) {
    console.error("API Error:", data);
    return;
  }

  const a = data.analysis;
  console.log("Overall Status:", a.overallStatus);
  console.log("Eligibility Score:", a.eligibilityScore + "%");
  console.log("Eligible:", a.eligible);
  console.log("Determination Explanation:\n  " + a.explanation);
  console.log("Criteria Breakdown (" + a.criteria.length + "):");
  a.criteria.forEach((c) => {
    console.log("  [" + c.type.toUpperCase() + "] " + c.criterion + ": " + c.status + " | Page " + c.page + " (§" + c.section + ") Verified: " + c.verified);
  });
  console.log("Contraindications (" + a.contraindications.length + "):");
  a.contraindications.forEach((ci) => {
    console.log("  ⚠ " + ci.issue + " [" + ci.severity + "] | Page " + ci.page + " (§" + ci.section + ")");
  });
  console.log("Retrieval Stats:", JSON.stringify(a.retrievalStats));
}

async function run() {
  // Test Candidate A: Standard Patient (eGFR 42 mL/min - avoids renal exclusion)
  await testCandidate(
    "Candidate A (eGFR 42 mL/min - avoids renal exclusion)",
    "Age: 54\nSex: Female\nDiagnosis: Type 2 diabetes mellitus\nHbA1c: 7.4%\neGFR: 42 mL/min/1.73m²\nMedical history: Hypertension\nCurrent medications: Metformin, amlodipine"
  );

  // Test Candidate B: Disqualified Patient (eGFR 22 mL/min - critical exclusion violation)
  await testCandidate(
    "Candidate B (eGFR 22 mL/min - violates renal exclusion)",
    "Age: 54\nSex: Female\nDiagnosis: Type 2 diabetes mellitus\nHbA1c: 7.4%\neGFR: 22 mL/min/1.73m² (severe renal impairment)\nMedical history: Hypertension\nCurrent medications: Metformin"
  );
}

run();
