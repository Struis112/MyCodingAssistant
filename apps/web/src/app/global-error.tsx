"use client";

// Custom App-Router global error page. Two jobs:
//  1. Last-resort UI if the ROOT layout itself throws at runtime.
//  2. Build fix: Next 16's built-in /_global-error fails to prerender when the
//     root layout is force-dynamic (useContext-of-null inside Next's own
//     compiled chunk). Supplying our own replaces that broken default.
// Must render its own <html>/<body> — the root layout is out of the picture
// when this shows. Styling is inline because globals.css may not have loaded.

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "12px",
          fontFamily: "system-ui, sans-serif",
          background: "#0a0a0a",
          color: "#fafafa",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "18px" }}>Something went wrong</h2>
        <p style={{ margin: 0, fontSize: "14px", color: "#a3a3a3" }}>
          The app hit an unrecoverable error.
        </p>
        <button
          onClick={reset}
          style={{
            padding: "8px 16px",
            fontSize: "14px",
            borderRadius: "6px",
            border: "1px solid #404040",
            background: "#171717",
            color: "#fafafa",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
