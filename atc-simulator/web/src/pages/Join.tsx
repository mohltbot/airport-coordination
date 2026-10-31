import { useEffect, useRef, useState } from "react";
import { useSimulator } from "../hooks/useSimulator";
import "../components/controller.css";

// Kept only in memory. Module lifetime also prevents StrictMode remounts from
// consuming the one-time fragment twice; remove it before any network exchange.
let captured = false;
let capability: string | null = null;
function captureCapability() {
  if (!captured) {
    captured = true;
    capability = new URLSearchParams(window.location.hash.slice(1)).get(
      "token",
    );
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
  }
  return capability;
}
export function Join() {
  const { join } = useSimulator();
  const token = useRef(captureCapability());
  const started = useRef(false);
  const [state, setState] = useState<"idle" | "joining" | "error" | "missing">(
    "idle",
  );
  async function exchange() {
    if (!token.current) {
      setState("missing");
      return;
    }
    setState("joining");
    try {
      const bootstrap = await join(token.current);
      if (bootstrap.session.role === "VIEWER") {
        setState("error");
        return;
      }
      token.current = null;
      capability = null;
      window.location.replace(
        bootstrap.session.role === "CONTROLLER" ? "/control" : "/",
      );
    } catch {
      setState("error");
    }
  }
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      void exchange();
    }
  }, []);
  return (
    <main className="join-page">
      <p>GHOST TOWER</p>
      <h1>Join the simulation</h1>
      {(state === "joining" || state === "idle") && (
        <p role="status">Exchanging your invitation…</p>
      )}
      {state === "missing" && (
        <section>
          <h2>Invitation required</h2>
          <p>
            Ask the operator for a fresh invite and open the complete join link.
          </p>
          <a href="/">View simulation</a>
        </section>
      )}
      {state === "error" && (
        <section role="alert">
          <h2>Could not join</h2>
          <p>
            Retry the invitation. If it expired, was already used, or the run
            was reset, ask the operator for a fresh invite.
          </p>
          <button type="button" onClick={() => void exchange()}>
            Retry invitation
          </button>
        </section>
      )}
    </main>
  );
}
