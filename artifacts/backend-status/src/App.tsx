function App() {
  return (
    <div style={{
      minHeight: "100vh",
      width: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#0b0e14",
      color: "#e6e8eb",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      padding: "2rem",
      boxSizing: "border-box",
    }}>
      <div style={{ maxWidth: 640, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Ownership &amp; Attestation Protocol
        </h1>
        <p style={{ fontSize: "0.95rem", color: "#a9b0bb", lineHeight: 1.6, marginBottom: "1.5rem" }}>
          This is a backend API and MCP service. There is no user interface here.
        </p>
        <div style={{
          textAlign: "left",
          background: "#151a24",
          border: "1px solid #232a38",
          borderRadius: 8,
          padding: "1rem 1.25rem",
          fontSize: "0.85rem",
          lineHeight: 1.8,
        }}>
          <div>REST API: <code>/api</code></div>
          <div>MCP endpoint: <code>/mcp</code> (requires <code>Authorization: Bearer &lt;MCP_ACCESS_TOKEN&gt;</code>)</div>
        </div>
      </div>
    </div>
  );
}

export default App;
