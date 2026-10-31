import { useEffect, useId, useRef, useState } from "react";
import QRCode from "qrcode";
import type { RunConfig } from "@ghost-tower/domain/public";
import { useSimulator } from "../hooks/useSimulator";

export function RunSetup() {
  const sim = useSimulator();
  const config = sim.snapshot?.config ?? sim.bootstrap?.activeRun?.config;
  const [count, setCount] = useState(String(config?.flightCount ?? 10));
  const [seed, setSeed] = useState(String(config?.seed ?? 20261031));
  const [speed, setSpeed] = useState<1 | 5 | 10>(config?.speed ?? 5);
  const [network, setNetwork] = useState<"US" | "LEGACY">(config?.airportNetwork ?? "US");
  const [continuous, setContinuous] = useState(config?.continuousTraffic ?? true);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const flightCount = Number(count),
    seedNumber = Number(seed);
  const valid =
    count.trim() !== "" &&
    Number.isInteger(flightCount) &&
    flightCount >= 1 &&
    flightCount <= 30 &&
    seed.trim() !== "" &&
    Number.isInteger(seedNumber) &&
    seedNumber >= 0 &&
    seedNumber <= 4294967295;
  const operator =
    sim.bootstrap?.session.role === "OPERATOR" &&
    !sim.sessionExpired &&
    !sim.isFixture;
  const phase = sim.snapshot?.phase ?? sim.bootstrap?.activeRun?.phase;
  const retryingStart = phase === "STARTING";
  const locked = sim.busy || (!!phase && phase !== "CONFIGURING");
  const startLocked =
    sim.busy || (!!phase && !["CONFIGURING", "STARTING"].includes(phase));
  const unavailable =
    sim.snapshot &&
    (["actors", "relay", "worker"] as const).some(
      (k) => sim.snapshot!.health[k].status === "UNAVAILABLE",
    );
  const start = async () => {
    if (!valid || startLocked) return;
    setError(null);
    try {
      await sim.start({
        flightCount,
        seed: seedNumber,
        speed,
        airportNetwork: network,
        continuousTraffic: continuous,
      } satisfies RunConfig);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not start this run. Retry to resume initialization.",
      );
    }
  };
  return (
    <section className="run-setup" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Set the airspace</h2>
      <p className="muted">{network === "US" ? "Ten real airports. One shared sky." : "Three towers. Your choice of traffic."}</p>
      <fieldset disabled={!operator || locked}>
        <label htmlFor={`${id}-network`}>Airport network</label>
        <select id={`${id}-network`} value={network} onChange={(event) => setNetwork(event.target.value as "US" | "LEGACY")}>
          <option value="US">United States · 10 busiest airports</option>
          <option value="LEGACY">Legacy · 3 airport test network</option>
        </select>
        <label className="continuous-setting"><input type="checkbox" checked={continuous} onChange={(event) => setContinuous(event.target.checked)} /> Keep traffic flowing</label>
        <p className="continuous-note">Launch a new flight after each arrival or unresolved flight, keeping your chosen number active.</p>
        <label htmlFor={`${id}-count`}>
          Flights <span className="muted">1–30</span>
        </label>
        <input
          id={`${id}-count`}
          type="number"
          min="1"
          max="30"
          value={count}
          onChange={(e) => setCount(e.target.value)}
        />
        <input
          aria-label="Flight count slider"
          type="range"
          min="1"
          max="30"
          value={
            Number.isFinite(flightCount)
              ? Math.min(30, Math.max(1, flightCount))
              : 10
          }
          onChange={(e) => setCount(e.target.value)}
        />
        <label htmlFor={`${id}-seed`}>Scenario seed</label>
        <input
          id={`${id}-seed`}
          type="number"
          min="0"
          max="4294967295"
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
        />
        <label htmlFor={`${id}-speed`}>Simulation speed</label>
        <select
          id={`${id}-speed`}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value) as 1 | 5 | 10)}
        >
          <option value={1}>1× real time</option>
          <option value={5}>5× accelerated</option>
          <option value={10}>10× accelerated</option>
        </select>
      </fieldset>
      <p className="setup-summary">
        <strong>{valid ? flightCount : "—"} flights</strong>
        <span>{network === "US" ? 10 : 3} ATC agents</span>
      </p>
      {!valid && (
        <p className="error-text">
          Choose 1–30 flights and a whole-number seed from 0 to 4,294,967,295.
        </p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {unavailable && (
        <p className="error-text">
          A required service is unavailable. Check dependency health before
          starting.
        </p>
      )}
      <button
        className="primary full-width"
        disabled={!operator || !valid || startLocked || !!unavailable}
        onClick={() => void start()}
      >
        {sim.busy
          ? "Preparing agents…"
          : retryingStart
            ? "Retry initialization"
            : "Start simulation"}
      </button>
      {retryingStart && !sim.busy && (
        <p className="muted">
          Initialization is incomplete. Retry continues setup for this run.
        </p>
      )}
      {!operator && (
        <p className="muted">
          {sim.isFixture
            ? "Development preview. Controls are disabled."
            : "Open the operator join link printed by the server to start a run."}
        </p>
      )}
      <p className="setup-note">
        Incidents travel through Agent Relay. Watch each tower and pilot decide
        how to respond.
      </p>
    </section>
  );
}

export function PhoneInvite({ onClose }: { onClose: () => void }) {
  const sim = useSimulator();
  const dialog = useRef<HTMLDialogElement>(null);
  const requested = useRef(false);
  const [invite, setInvite] = useState<{
    joinUrl: string;
    expiresAtWallMs: number;
  } | null>(null);
  const [qr, setQr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    if (!requested.current) {
      requested.current = true;
      void sim
        .invite()
        .then(async (value) => {
          setInvite(value);
          setQr(
            await QRCode.toDataURL(value.joinUrl, {
              width: 256,
              margin: 2,
              errorCorrectionLevel: "M",
            }),
          );
        })
        .catch((e) =>
          setError(
            e instanceof Error
              ? e.message
              : "Could not create a phone invitation.",
          ),
        );
    }
  }, [sim.invite]);
  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.joinUrl);
      setCopied(true);
    } catch {
      setError("Copy unavailable. Select and copy the link below.");
    }
  };
  return (
    <dialog
      ref={dialog}
      className="invite-dialog"
      aria-labelledby="invite-title"
      onCancel={onClose}
    >
      <div className="dialog-heading">
        <h2 id="invite-title">Control from your phone</h2>
        <button onClick={onClose} aria-label="Close phone invitation">
          Close
        </button>
      </div>
      <p>
        Scan to join this run. Trigger an incident, then watch the agents
        coordinate.
      </p>
      {qr ? (
        <img
          className="invite-qr"
          src={qr}
          alt="QR code for this run’s one-time controller invitation"
          width="256"
          height="256"
        />
      ) : (
        <p role="status">
          {error ? "Invitation unavailable." : "Creating a secure invitation…"}
        </p>
      )}
      {invite && (
        <>
          <label htmlFor="invite-link">One-time join link</label>
          <input
            id="invite-link"
            readOnly
            value={invite.joinUrl}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button className="primary" onClick={() => void copy()}>
            {copied ? "Link copied" : "Copy join link"}
          </button>
          <p className="muted">
            Expires at {new Date(invite.expiresAtWallMs).toLocaleTimeString()}.
            A new phone needs a fresh invitation.
          </p>
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}

export function ResetDialog({ onClose }: { onClose: () => void }) {
  const sim = useSimulator(),
    dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const reset = async () => {
    try {
      await sim.reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed. Try again.");
    }
  };
  return (
    <dialog
      ref={dialog}
      className="reset-dialog"
      aria-labelledby="reset-title"
      onCancel={onClose}
    >
      <h2 id="reset-title">End this scenario?</h2>
      <p>
        Reset creates a fresh run. The current scenario remains in history, and
        phones will need new invitations.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button onClick={onClose}>Keep this run</button>
        <button
          className="danger"
          disabled={sim.busy}
          onClick={() => void reset()}
        >
          {sim.busy ? "Resetting…" : "Reset scenario"}
        </button>
      </div>
    </dialog>
  );
}
