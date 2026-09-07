"use client";

// Shown when a page throws. The error is already reported server-side; the
// person just needs a way back and a reference to quote.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ maxWidth: 520, margin: "48px auto" }}>
      <div className="eyebrow">Something went wrong</div>
      <h1 style={{ margin: "6px 0 10px" }}>That didn't work</h1>
      <p className="muted">Nothing was approved or spent by this page. If it keeps happening, quote the reference below.</p>
      {error.digest && <p className="mono faint">ref {error.digest}</p>}
      <div className="actions"><button className="btn" onClick={reset}>Try again</button><a className="btn secondary" href="/">Go to the exposure book</a></div>
    </div>
  );
}
