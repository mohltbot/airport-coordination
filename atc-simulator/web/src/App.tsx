import { Component, useEffect, useState, type ReactNode } from "react";
import type { PublicSnapshot } from "@ghost-tower/domain/public";
import { SimulatorProvider } from "./hooks/useSimulator";
import { Display } from "./pages/Display";
import { Controller } from "./pages/Controller";
import { Join } from "./pages/Join";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="fatal-state">
        <h1>iATC</h1>
        <h2>The display could not load</h2>
        <p>
          Reload to fetch the current run. Simulation state remains on the
          server.
        </p>
        <button onClick={() => location.reload()}>Reload display</button>
      </main>
    ) : (
      this.props.children
    );
  }
}

export function App() {
  const preview = import.meta.env.DEV && location.pathname === "/preview";
  const [fixture, setFixture] = useState<PublicSnapshot>();
  const [fixtureError, setFixtureError] = useState(false);
  useEffect(() => {
    if (import.meta.env.DEV && preview)
      void import("./dev/us-preview")
        .then(({ usPreviewSnapshot }) => setFixture(usPreviewSnapshot))
        .catch(() => setFixtureError(true));
  }, [preview]);
  if (preview && !fixture)
    return (
      <main className="fatal-state">
        <h1>iATC</h1>
        <p>
          {fixtureError
            ? "Development fixture failed validation."
            : "Loading development fixture…"}
        </p>
      </main>
    );
  const page =
    location.pathname === "/join" ? (
      <Join />
    ) : location.pathname === "/control" ? (
      <Controller />
    ) : (
      <Display />
    );
  return (
    <ErrorBoundary>
      <SimulatorProvider fixture={fixture}>{page}</SimulatorProvider>
    </ErrorBoundary>
  );
}
