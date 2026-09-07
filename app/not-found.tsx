import Link from "next/link";
export default function NotFound() {
  return (
    <div style={{ maxWidth: 520, margin: "48px auto" }}>
      <div className="eyebrow">404</div>
      <h1 style={{ margin: "6px 0 10px" }}>Nothing here</h1>
      <p className="muted">The page doesn't exist, or belongs to a workspace you're not in.</p>
      <Link className="btn secondary" href="/">Go to the exposure book</Link>
    </div>
  );
}
