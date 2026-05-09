"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { interpolateLatLng } from "@/lib/geo";
import type { AlertSeverity, DirectiveType, LatLng, ShipState, SimulatorSnapshot } from "@/lib/domain";

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 620;

type Role = "command" | "captain";

const directiveLabels: Record<DirectiveType, string> = {
  HOLD_POSITION: "Hold",
  RESUME_COURSE: "Resume",
  CHANGE_SPEED: "Speed",
  REROUTE_PORT: "Reroute",
};

function severityClass(severity: AlertSeverity): string {
  if (severity === "critical") {
    return "border-red-500/70 bg-red-950/45 text-red-100";
  }

  if (severity === "warning") {
    return "border-amber-400/70 bg-amber-950/35 text-amber-100";
  }

  return "border-cyan-400/50 bg-cyan-950/30 text-cyan-100";
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function postJson(path: string, body: unknown): Promise<void> {
  return fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).then((response) => {
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
  });
}

function StatusDot({ status }: { status: ShipState["status"] }) {
  const color =
    status === "normal"
      ? "bg-emerald-400"
      : status === "insufficient_fuel" || status === "rerouting"
        ? "bg-amber-300"
        : status === "arrived"
          ? "bg-cyan-300"
          : "bg-red-400";

  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

export default function Page() {
  const [snapshot, setSnapshot] = useState<SimulatorSnapshot | null>(null);
  const [role, setRole] = useState<Role>("command");
  const [selectedShipId, setSelectedShipId] = useState("MV-1");
  const [captainShipId, setCaptainShipId] = useState("MV-1");
  const [directiveType, setDirectiveType] = useState<DirectiveType>("HOLD_POSITION");
  const [speedKnots, setSpeedKnots] = useState(12);
  const [destinationPortId, setDestinationPortId] = useState("MCT-1");
  const [distressMessage, setDistressMessage] = useState(
    "Engine vibration rising; 2 crew injured, requesting medical support.",
  );
  const [now, setNow] = useState(0);
  const [connectionState, setConnectionState] = useState("connecting");

  useEffect(() => {
    const source = new EventSource("/api/sim/stream");

    source.addEventListener("snapshot", (event) => {
      setSnapshot(JSON.parse((event as MessageEvent).data) as SimulatorSnapshot);
      setConnectionState("live");
    });
    source.onerror = () => setConnectionState("reconnecting");

    return () => source.close();
  }, []);

  useEffect(() => {
    const frame = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(frame);
  }, []);

  const visibleShips = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    return snapshot.ships.map((ship) => ({
      ...ship,
      position: interpolateLatLng(ship.previousPosition, ship.position, (now - ship.lastUpdateAt) / 1000),
    }));
  }, [now, snapshot]);

  const selectedShip = visibleShips.find((ship) => ship.id === selectedShipId) ?? visibleShips[0];
  const captainShip = visibleShips.find((ship) => ship.id === captainShipId) ?? visibleShips[0];
  const pendingCaptainDirectives =
    snapshot?.directives.filter(
      (directive) => directive.targetShipId === captainShipId && directive.status === "pending",
    ) ?? [];
  const activeAlerts = snapshot?.alerts.filter((alert) => !alert.resolvedAt && !alert.acknowledgedAt) ?? [];

  function project(point: LatLng): [number, number] {
    if (!snapshot) {
      return [0, 0];
    }

    const { boundingBox } = snapshot;
    const x = ((point[1] - boundingBox.west) / (boundingBox.east - boundingBox.west)) * MAP_WIDTH;
    const y = ((boundingBox.north - point[0]) / (boundingBox.north - boundingBox.south)) * MAP_HEIGHT;

    return [x, y];
  }

  async function issueDirective(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload =
      directiveType === "CHANGE_SPEED"
        ? { speedKnots }
        : directiveType === "REROUTE_PORT"
          ? { destinationPortId }
          : {};

    await postJson("/api/sim/directives", {
      targetShipId: selectedShipId,
      directiveType,
      payload,
    });
  }

  async function createZoneAroundShip() {
    if (!selectedShip) {
      return;
    }

    const [lat, lng] = selectedShip.position;
    const polygon: LatLng[] = [
      [lat + 0.14, lng - 0.16],
      [lat + 0.14, lng + 0.16],
      [lat - 0.14, lng + 0.16],
      [lat - 0.14, lng - 0.16],
      [lat + 0.14, lng - 0.16],
    ];

    await postJson("/api/sim/zones", {
      name: `Emergency Box ${selectedShip.id}`,
      polygon,
    });
  }

  async function respondToDirective(directiveId: string, responseType: "ACCEPT" | "ESCALATE_DISTRESS") {
    await postJson("/api/sim/responses", {
      directiveId,
      responseType,
      distressMessage: responseType === "ESCALATE_DISTRESS" ? distressMessage : undefined,
    });
  }

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#071013] text-slate-100">
        <div className="border border-cyan-300/30 bg-cyan-300/10 px-6 py-4 text-sm uppercase tracking-[0.2em] text-cyan-100">
          Connecting to simulator stream
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#071013] text-slate-100">
      <header className="border-b border-white/10 bg-[#0b1518] px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-wide">Fleet Crisis Command</h1>
            <p className="text-xs text-slate-400">
              {snapshot.scenarioName} - {snapshot.metrics.activeShips} ships - tick {snapshot.tick}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-emerald-100">
              {connectionState}
            </span>
            <span className="border border-white/10 px-3 py-1 text-slate-300">
              viewers {snapshot.metrics.connectedViewers}
            </span>
            <div className="flex border border-white/10">
              <button
                className={`px-3 py-1 ${role === "command" ? "bg-cyan-300 text-slate-950" : "text-slate-300"}`}
                onClick={() => setRole("command")}
                type="button"
              >
                Command
              </button>
              <button
                className={`px-3 py-1 ${role === "captain" ? "bg-cyan-300 text-slate-950" : "text-slate-300"}`}
                onClick={() => setRole("captain")}
                type="button"
              >
                Captain
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-65px)] grid-cols-1 xl:grid-cols-[320px_1fr_360px]">
        <aside className="border-b border-white/10 bg-[#0b1518] p-4 xl:border-b-0 xl:border-r">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-300">Fleet</h2>
            <span className="text-xs text-slate-500">{formatTime(snapshot.serverTime)}</span>
          </div>
          <div className="max-h-[44vh] space-y-2 overflow-auto pr-1 xl:max-h-[70vh]">
            {visibleShips.map((ship) => (
              <button
                className={`grid w-full grid-cols-[1fr_auto] gap-2 border px-3 py-2 text-left transition ${
                  selectedShipId === ship.id
                    ? "border-cyan-300 bg-cyan-300/12"
                    : "border-white/10 bg-white/[0.03] hover:border-white/25"
                }`}
                key={ship.id}
                onClick={() => {
                  setSelectedShipId(ship.id);
                  setCaptainShipId(ship.id);
                }}
                type="button"
              >
                <span>
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <StatusDot status={ship.status} /> {ship.name}
                  </span>
                  <span className="mt-1 block text-xs text-slate-400">
                    {ship.id} - {ship.cargo} - {ship.speedKnots.toFixed(0)} kt
                  </span>
                </span>
                <span className="text-right text-xs text-slate-300">
                  {ship.fuelTons.toFixed(0)}
                  <span className="block text-slate-500">tons</span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="relative min-h-[520px] bg-[#0a1c22]">
          <svg className="h-full min-h-[520px] w-full" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="img">
            <defs>
              <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
                <path d="M 50 0 L 0 0 0 50" fill="none" stroke="rgba(148, 163, 184, 0.12)" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="#08212a" />
            <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#grid)" />
            <polygon
              fill="rgba(20, 184, 166, 0.13)"
              points={snapshot.navigableWater.map((point) => project(point).join(",")).join(" ")}
              stroke="rgba(45, 212, 191, 0.55)"
              strokeWidth="2"
            />
            {snapshot.restrictedZones.map((zone) => (
              <polygon
                fill="rgba(239, 68, 68, 0.22)"
                key={zone.id}
                points={zone.polygon.map((point) => project(point).join(",")).join(" ")}
                stroke="rgba(248, 113, 113, 0.9)"
                strokeDasharray="8 6"
                strokeWidth="2"
              />
            ))}
            {snapshot.ports.map((port) => {
              const [x, y] = project(port.position);

              return (
                <g key={port.id}>
                  <rect fill="#d9f99d" height="10" width="10" x={x - 5} y={y - 5} />
                  <text fill="#d9f99d" fontSize="13" x={x + 8} y={y + 4}>
                    {port.name}
                  </text>
                </g>
              );
            })}
            {visibleShips.map((ship) => {
              const [x, y] = project(ship.position);
              const selected = ship.id === selectedShipId;

              return (
                <g
                  className="cursor-pointer"
                  key={ship.id}
                  onClick={() => {
                    setSelectedShipId(ship.id);
                    setCaptainShipId(ship.id);
                  }}
                  transform={`translate(${x} ${y}) rotate(${ship.headingDegrees})`}
                >
                  <path
                    d="M 0 -12 L 8 10 L 0 6 L -8 10 Z"
                    fill={selected ? "#67e8f9" : "#f8fafc"}
                    stroke={ship.status === "normal" ? "#042f2e" : "#f59e0b"}
                    strokeWidth="2"
                  />
                  <circle fill="transparent" r="16" stroke={selected ? "#67e8f9" : "transparent"} strokeWidth="2" />
                </g>
              );
            })}
          </svg>

          <div className="absolute bottom-4 left-4 right-4 flex flex-wrap gap-2 text-xs">
            <span className="border border-white/10 bg-black/30 px-3 py-1">SSE live sync - 1 Hz backend tick</span>
            <span className="border border-white/10 bg-black/30 px-3 py-1">Client interpolation active</span>
            <span className="border border-white/10 bg-black/30 px-3 py-1">
              {snapshot.restrictedZones.length} zones - {activeAlerts.length} active alerts
            </span>
          </div>
        </section>

        <aside className="border-t border-white/10 bg-[#0b1518] p-4 xl:border-l xl:border-t-0">
          {role === "command" ? (
            <div className="space-y-5">
              <section className="border border-white/10 bg-white/[0.03] p-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-300">Selected Ship</h2>
                {selectedShip && (
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-xs text-slate-500">Name</dt>
                      <dd>{selectedShip.name}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">Status</dt>
                      <dd>{selectedShip.status}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">Fuel</dt>
                      <dd>{selectedShip.fuelTons.toFixed(1)} tons</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">Heading</dt>
                      <dd>{selectedShip.headingDegrees.toFixed(0)} deg</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-xs text-slate-500">Cargo</dt>
                      <dd>{selectedShip.cargo}</dd>
                    </div>
                  </dl>
                )}
              </section>

              <form className="border border-white/10 bg-white/[0.03] p-4" onSubmit={issueDirective}>
                <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-300">Directive</h2>
                <div className="mt-3 grid gap-3">
                  <select
                    className="border border-white/10 bg-[#071013] px-3 py-2 text-sm"
                    onChange={(event) => setDirectiveType(event.target.value as DirectiveType)}
                    value={directiveType}
                  >
                    {Object.entries(directiveLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {directiveType === "CHANGE_SPEED" && (
                    <input
                      className="border border-white/10 bg-[#071013] px-3 py-2 text-sm"
                      max={28}
                      min={0}
                      onChange={(event) => setSpeedKnots(Number(event.target.value))}
                      type="number"
                      value={speedKnots}
                    />
                  )}
                  {directiveType === "REROUTE_PORT" && (
                    <select
                      className="border border-white/10 bg-[#071013] px-3 py-2 text-sm"
                      onChange={(event) => setDestinationPortId(event.target.value)}
                      value={destinationPortId}
                    >
                      {snapshot.ports.map((port) => (
                        <option key={port.id} value={port.id}>
                          {port.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button className="bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950" type="submit">
                    Issue to {selectedShip?.name}
                  </button>
                  <button
                    className="border border-red-300/50 px-3 py-2 text-sm text-red-100"
                    onClick={createZoneAroundShip}
                    type="button"
                  >
                    Create Zone Around Ship
                  </button>
                </div>
              </form>

              <section className="border border-white/10 bg-white/[0.03] p-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-300">Alerts</h2>
                <div className="mt-3 max-h-72 space-y-2 overflow-auto">
                  {activeAlerts.length === 0 && <p className="text-sm text-slate-500">No unacknowledged alerts.</p>}
                  {activeAlerts.map((alert) => (
                    <div className={`border p-3 text-sm ${severityClass(alert.severity)}`} key={alert.id}>
                      <div className="flex items-start justify-between gap-3">
                        <p>{alert.message}</p>
                        <button
                          className="border border-white/20 px-2 py-1 text-xs"
                          onClick={() => postJson("/api/sim/alerts/ack", { alertId: alert.id })}
                          type="button"
                        >
                          Ack
                        </button>
                      </div>
                      <p className="mt-2 text-xs opacity-70">
                        {alert.type} - {formatTime(alert.createdAt)}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <div className="space-y-5">
              <section className="border border-white/10 bg-white/[0.03] p-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-300">Captain Console</h2>
                <select
                  className="mt-3 w-full border border-white/10 bg-[#071013] px-3 py-2 text-sm"
                  onChange={(event) => {
                    setCaptainShipId(event.target.value);
                    setSelectedShipId(event.target.value);
                  }}
                  value={captainShipId}
                >
                  {snapshot.ships.map((ship) => (
                    <option key={ship.id} value={ship.id}>
                      {ship.name}
                    </option>
                  ))}
                </select>
                {captainShip && (
                  <div className="mt-3 text-sm text-slate-300">
                    {captainShip.name} - {captainShip.status} - {captainShip.fuelTons.toFixed(0)} tons fuel
                  </div>
                )}
              </section>

              <section className="border border-white/10 bg-white/[0.03] p-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-300">Pending Directives</h2>
                <div className="mt-3 space-y-3">
                  {pendingCaptainDirectives.length === 0 && (
                    <p className="text-sm text-slate-500">No directives awaiting response.</p>
                  )}
                  {pendingCaptainDirectives.map((directive) => (
                    <div className="border border-white/10 bg-[#071013] p-3" key={directive.id}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{directiveLabels[directive.type]}</span>
                        <span className="text-xs text-slate-500">{formatTime(directive.issuedAt)}</span>
                      </div>
                      <textarea
                        className="mt-3 h-20 w-full border border-white/10 bg-black/25 p-2 text-sm text-slate-100"
                        onChange={(event) => setDistressMessage(event.target.value)}
                        value={distressMessage}
                      />
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          className="bg-emerald-300 px-3 py-2 text-sm font-semibold text-slate-950"
                          onClick={() => respondToDirective(directive.id, "ACCEPT")}
                          type="button"
                        >
                          Accept
                        </button>
                        <button
                          className="border border-red-300/50 px-3 py-2 text-sm text-red-100"
                          onClick={() => respondToDirective(directive.id, "ESCALATE_DISTRESS")}
                          type="button"
                        >
                          Escalate
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="border border-white/10 bg-white/[0.03] p-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-300">Visible Zones</h2>
                <p className="mt-3 text-sm text-slate-400">
                  Captains can see {snapshot.restrictedZones.length} active command zones and cannot edit them.
                </p>
              </section>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
