"use client";
export function PrintButton() {
  return <button className="btn" type="button" onClick={() => window.print()}>Print / save as PDF</button>;
}
