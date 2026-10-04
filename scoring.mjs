export const SCORING_WEIGHTS = Object.freeze({
  price_score: 0.25,
  history_score: 0.25,
  technical_score: 0.20,
  liquidity_score: 0.15,
  emotion_score: 0.10,
  trim_score: 0.05,
});

const clamp = (n) => Math.max(0, Math.min(10, Number(n || 0)));

export function weightedScore(a = {}) {
  let total = 0;
  for (const [key, weight] of Object.entries(SCORING_WEIGHTS)) {
    total += clamp(a[key]) * weight;
  }
  return Math.round(total * 100) / 100;
}

export function calibrateAnalysis(a = {}) {
  const out = { ...a };

  for (const key of Object.keys(SCORING_WEIGHTS)) {
    out[key] = clamp(out[key]);
  }

  // Missing evidence is uncertainty, not proof that the car is bad.
  // Confidence handles uncertainty; category scores should stay neutral-ish
  // unless there is actual adverse evidence.
  if (out.history_evidence === "insufficient") {
    out.history_score = Math.max(out.history_score, 6.5);
  }
  if (out.technical_evidence === "insufficient") {
    out.technical_score = Math.max(out.technical_score, 6.5);
  }

  // Positive evidence should not coexist with a catastrophically low subscore.
  // These are only soft floors; actual mixed/negative evidence remains untouched.
  if (out.history_evidence === "positive") {
    out.history_score = Math.max(out.history_score, 7.0);
  }
  if (out.technical_evidence === "positive") {
    out.technical_score = Math.max(out.technical_score, 7.0);
  }

  out.confidence_pct = Math.max(0, Math.min(100, Number(out.confidence_pct || 0)));
  return out;
}

export const CALIBRATION_ANCHORS = Object.freeze([
  {
    name: "Strong Acura TLX-style deal",
    expected: [8.4, 8.8],
    scores: { price_score: 9.0, history_score: 8.2, technical_score: 8.4, liquidity_score: 8.5, emotion_score: 8.8, trim_score: 8.5 },
  },
  {
    name: "Good Audi A5-style deal",
    expected: [8.0, 8.4],
    scores: { price_score: 8.5, history_score: 7.6, technical_score: 8.0, liquidity_score: 8.2, emotion_score: 8.2, trim_score: 8.0 },
  },
  {
    name: "Good Mustang-style deal",
    expected: [7.8, 8.2],
    scores: { price_score: 8.2, history_score: 7.5, technical_score: 7.5, liquidity_score: 7.5, emotion_score: 9.0, trim_score: 8.0 },
  },
  {
    name: "Solid Audi S3-style deal",
    expected: [7.5, 7.9],
    scores: { price_score: 7.6, history_score: 7.2, technical_score: 7.8, liquidity_score: 8.0, emotion_score: 8.5, trim_score: 8.0 },
  },
  {
    name: "Solid Lexus IS350-style deal",
    expected: [7.4, 7.8],
    scores: { price_score: 7.3, history_score: 7.0, technical_score: 8.3, liquidity_score: 7.8, emotion_score: 7.6, trim_score: 7.5 },
  },
]);

export function runScoringRegression() {
  const failures = [];

  for (const b of CALIBRATION_ANCHORS) {
    const score = weightedScore(b.scores);
    if (score < b.expected[0] || score > b.expected[1]) {
      failures.push(`${b.name}: score ${score} outside ${b.expected[0]}-${b.expected[1]}`);
    }
  }

  const unknown = calibrateAnalysis({
    price_score: 8,
    history_score: 2,
    technical_score: 3,
    liquidity_score: 8,
    emotion_score: 8,
    trim_score: 8,
    history_evidence: "insufficient",
    technical_evidence: "insufficient",
    confidence_pct: 45,
  });

  if (unknown.history_score < 6.5 || unknown.technical_score < 6.5) {
    failures.push("Unknown-only evidence incorrectly crushes history/technical score");
  }

  const confirmedBad = calibrateAnalysis({
    history_score: 3,
    technical_score: 4,
    history_evidence: "negative",
    technical_evidence: "negative",
    confidence_pct: 90,
  });

  if (confirmedBad.history_score !== 3 || confirmedBad.technical_score !== 4) {
    failures.push("Confirmed negative evidence was incorrectly softened");
  }

  return failures;
}
