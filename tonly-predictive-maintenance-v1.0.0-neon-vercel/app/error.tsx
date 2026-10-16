"use client";

import { useEffect } from "react";

export default function ApplicationError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("TONLY application error", error); }, [error]);
  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, fontFamily: "system-ui, sans-serif", color: "#26344b" }}>
    <section style={{ maxWidth: 560 }}>
      <h1>Something went wrong</h1>
      <p>The application could not complete this view. Your source file has not been modified by this error. Retry, or check the deployment logs if it continues.</p>
      {error.digest ? <p>Reference: {error.digest}</p> : null}
      <button onClick={() => reset()} style={{ padding: "10px 14px", borderRadius: 8, border: 0, background: "#2f6fed", color: "white", cursor: "pointer" }}>Try again</button>
    </section>
  </main>;
}
