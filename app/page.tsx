"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { interpolateLatLng } from "@/lib/geo";
import { Button } from "@/components/ui/button";
import type {
  AlertSeverity,
  DirectiveType,
  LatLng,
  ShipState,
  SimulatorSnapshot,
  SimulatorStreamEvent,
} from "@/lib/domain";

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

function formatStatus(status: ShipState["status"]): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function toCardinal(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

function postJson(
  path: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST",
): Promise<void> {
  return fetch(path, {
    method,
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

const MAX_FUEL_TONS = 10000;

function statusColor(status: ShipState["status"]) {
  if (status === "normal" || status === "arrived") return "emerald";
  if (status === "rerouting" || status === "insufficient_fuel") return "amber";
  return "red";
}

function FuelBar({
  fuel,
  max = MAX_FUEL_TONS,
  className = "",
}: {
  fuel: number;
  max?: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, (fuel / max) * 100));
  const color =
    pct > 50 ? "bg-emerald-400" : pct > 25 ? "bg-amber-400" : "bg-red-500";
  return (
    <div className={`fuel-bar-track ${className}`}>
      <div
        className={`h-full rounded-sm transition-all duration-700 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function Page() {
  const [snapshot, setSnapshot] = useState<SimulatorSnapshot | null>(null);
  const [role, setRole] = useState<Role>("command");
  const [selectedShipId, setSelectedShipId] = useState("MV-1");
  const [captainShipId, setCaptainShipId] = useState("MV-1");
  const [directiveType, setDirectiveType] =
    useState<DirectiveType>("HOLD_POSITION");
  const [speedKnots, setSpeedKnots] = useState(12);
  const [destinationPortId, setDestinationPortId] = useState("MCT-1");
  const [distressMessage, setDistressMessage] = useState(
    "Engine vibration rising; 2 crew injured, requesting medical support.",
  );
  const [now, setNow] = useState(0);
  const [connectionState, setConnectionState] = useState("connecting");
  const [streamLagMs, setStreamLagMs] = useState(0);
  const [playbackIndex, setPlaybackIndex] = useState<number | null>(null);
  const latestVersionRef = useRef(-1);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drawingMode, setDrawingMode] = useState(false);
  const [draftPolygon, setDraftPolygon] = useState<LatLng[]>([]);
  const [mouseMapPos, setMouseMapPos] = useState<[number, number] | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/sim/stream");

    source.addEventListener("snapshot", (event) => {
      const streamEvent = JSON.parse(
        (event as MessageEvent).data,
      ) as SimulatorStreamEvent;
      const nextSnapshot = streamEvent.snapshot;

      if (nextSnapshot.stateVersion <= latestVersionRef.current) {
        return;
      }

      latestVersionRef.current = nextSnapshot.stateVersion;
      setSnapshot(nextSnapshot);
      setStreamLagMs(Math.max(0, Date.now() - streamEvent.sentAt));
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
      position: interpolateLatLng(
        ship.previousPosition,
        ship.position,
        (now - ship.lastUpdateAt) / 1000,
      ),
    }));
  }, [now, snapshot]);

  const playbackCursor =
    playbackIndex !== null && snapshot
      ? Math.min(playbackIndex, Math.max(0, snapshot.history.length - 1))
      : 0;
  const playbackFrame =
    playbackIndex !== null && snapshot && snapshot.history.length > 0
      ? snapshot.history[playbackCursor]
      : undefined;
  const inPlayback = Boolean(playbackFrame);

  const renderedShips = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    if (!playbackFrame) {
      return visibleShips;
    }

    const byId = new Map(
      playbackFrame.shipPositions.map((position) => [
        position.shipId,
        position,
      ]),
    );
    return snapshot.ships.map((ship) => {
      const historical = byId.get(ship.id);
      if (!historical) {
        return ship;
      }

      return {
        ...ship,
        position: historical.position,
        previousPosition: historical.position,
        status: historical.status,
        fuelTons: historical.fuelTons,
      };
    });
  }, [playbackFrame, snapshot, visibleShips]);

  const selectedShip =
    renderedShips.find((ship) => ship.id === selectedShipId) ??
    renderedShips[0];
  const captainShip =
    renderedShips.find((ship) => ship.id === captainShipId) ?? renderedShips[0];
  const listedShips =
    role === "command"
      ? renderedShips
      : renderedShips.filter((ship) => ship.id === captainShipId);
  const pendingCaptainDirectives =
    snapshot?.directives.filter(
      (directive) =>
        directive.targetShipId === captainShipId &&
        directive.status === "pending",
    ) ?? [];
  const activeAlerts =
    (inPlayback
      ? []
      : snapshot?.alerts.filter(
          (alert) => !alert.resolvedAt && !alert.acknowledgedAt,
        )) ?? [];

  function project(point: LatLng): [number, number] {
    if (!snapshot) {
      return [0, 0];
    }

    const { boundingBox } = snapshot;
    const x =
      ((point[1] - boundingBox.west) / (boundingBox.east - boundingBox.west)) *
      MAP_WIDTH;
    const y =
      ((boundingBox.north - point[0]) /
        (boundingBox.north - boundingBox.south)) *
      MAP_HEIGHT;

    return [x, y];
  }

  // Compute a tight viewBox around the actual content so the map fills the panel.
  const { mapViewBox, mapOriginX, mapOriginY } = useMemo(() => {
    if (!snapshot)
      return {
        mapViewBox: `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`,
        mapOriginX: 0,
        mapOriginY: 0,
      };
    const { boundingBox } = snapshot;
    const px = (pt: LatLng): [number, number] => [
      ((pt[1] - boundingBox.west) / (boundingBox.east - boundingBox.west)) *
        MAP_WIDTH,
      ((boundingBox.north - pt[0]) / (boundingBox.north - boundingBox.south)) *
        MAP_HEIGHT,
    ];
    const pts: LatLng[] = [
      ...snapshot.navigableWater,
      ...snapshot.ports.map((p) => p.position),
    ];
    const xs = pts.map((p) => px(p)[0]);
    const ys = pts.map((p) => px(p)[1]);
    const pad = 55;
    const x0 = Math.max(0, Math.min(...xs) - pad);
    const y0 = Math.max(0, Math.min(...ys) - pad);
    const x1 = Math.min(MAP_WIDTH, Math.max(...xs) + pad);
    const y1 = Math.min(MAP_HEIGHT, Math.max(...ys) + pad);
    return {
      mapViewBox: `${x0 | 0} ${y0 | 0} ${(x1 - x0) | 0} ${(y1 - y0) | 0}`,
      mapOriginX: x0,
      mapOriginY: y0,
    };
  }, [snapshot]);

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

  async function respondToDirective(
    directiveId: string,
    responseType: "ACCEPT" | "ESCALATE_DISTRESS",
  ) {
    await postJson("/api/sim/responses", {
      directiveId,
      shipId: captainShipId,
      responseType,
      distressMessage:
        responseType === "ESCALATE_DISTRESS" ? distressMessage : undefined,
    });
  }

  async function setZoneActive(zoneId: string, active: boolean) {
    await postJson("/api/sim/zones", { zoneId, active }, "PATCH");
  }

  function unproject(x: number, y: number): LatLng {
    const bb = snapshot!.boundingBox;
    const lat = bb.north - (y / MAP_HEIGHT) * (bb.north - bb.south);
    const lng = bb.west + (x / MAP_WIDTH) * (bb.east - bb.west);
    return [lat, lng];
  }

  function getSvgPoint(
    e: React.MouseEvent<SVGSVGElement>,
  ): [number, number] | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const parts = mapViewBox.split(" ").map(Number);
    const [vx, vy, vw, vh] = parts;
    const x = vx + ((e.clientX - rect.left) / rect.width) * vw;
    const y = vy + ((e.clientY - rect.top) / rect.height) * vh;
    return [x, y];
  }

  function handleMapClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!drawingMode || inPlayback || !snapshot) return;
    const pt = getSvgPoint(e);
    if (!pt) return;
    if (draftPolygon.length >= 3) {
      const [fx, fy] = project(draftPolygon[0]);
      if (Math.hypot(pt[0] - fx, pt[1] - fy) < 14) {
        submitDrawnZone();
        return;
      }
    }
    setDraftPolygon((prev) => [...prev, unproject(pt[0], pt[1])]);
  }

  function handleMapMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!drawingMode) return;
    setMouseMapPos(getSvgPoint(e));
  }

  async function submitDrawnZone() {
    if (draftPolygon.length < 3) return;
    const closed: LatLng[] = [...draftPolygon, draftPolygon[0]];
    await postJson("/api/sim/zones", {
      name: `Zone-${new Date().toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
      polygon: closed,
    });
    setDraftPolygon([]);
    setDrawingMode(false);
    setMouseMapPos(null);
  }

  function cancelDrawing() {
    setDraftPolygon([]);
    setDrawingMode(false);
    setMouseMapPos(null);
  }

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#050d12] text-slate-100">
        <div className="flex flex-col items-center gap-4">
          <div className="relative flex h-4 w-4">
            <span className="live-ring" />
            <span className="relative inline-flex h-4 w-4 rounded-full bg-cyan-400" />
          </div>
          <p className="text-xs uppercase tracking-[0.25em] text-cyan-400/80">
            Connecting to simulator stream
          </p>
        </div>
      </main>
    );
  }

  const destName = (id: string) =>
    snapshot.ports.find((p) => p.id === id)?.name ?? id;

  return (
    <main className="min-h-screen bg-[#050d12] text-slate-100">
      {/* Top accent bar */}
      <div className="h-[2px] w-full bg-linear-to-r from-transparent via-cyan-400 to-transparent opacity-70" />

      <header className="border-b border-white/8 bg-[#07151a] px-4 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="live-ring" />
              <span className="relative z-10 inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-bold tracking-widest text-white uppercase sm:text-base lg:text-lg">
                Fleet Crisis Command
              </h1>
              <p className="hidden text-[10px] tracking-wider text-slate-500 uppercase sm:block">
                {snapshot.scenarioName}&ensp;·&ensp;
                <span className="text-cyan-400">
                  {snapshot.metrics.activeShips} ships
                </span>
                &ensp;·&ensp;tick {snapshot.tick}
                {inPlayback && playbackFrame ? (
                  <>
                    &ensp;·&ensp;
                    <span className="text-amber-300">
                      playback {formatTime(playbackFrame.timestamp)}
                    </span>
                  </>
                ) : null}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 text-xs">
            <span className="rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300 uppercase tracking-wider">
              {connectionState}
            </span>
            <span className="hidden rounded-sm border border-white/8 bg-white/4 px-2 py-1 text-[10px] text-slate-400 md:inline">
              {snapshot.metrics.connectedViewers}v
            </span>
            <span className="hidden rounded-sm border border-white/8 bg-white/4 px-2 py-1 text-[10px] text-slate-400 sm:inline">
              <span className="text-cyan-300">{streamLagMs}ms</span>
            </span>
            <div className="flex overflow-hidden rounded-sm border border-white/10">
              <button
                className={`px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors sm:px-3 sm:text-xs ${role === "command" ? "bg-cyan-400 text-slate-950" : "text-slate-400 hover:text-slate-200"}`}
                onClick={() => setRole("command")}
                type="button"
              >
                Cmd
              </button>
              <div className="w-px bg-white/10" />
              <button
                className={`px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors sm:px-3 sm:text-xs ${role === "captain" ? "bg-cyan-400 text-slate-950" : "text-slate-400 hover:text-slate-200"}`}
                onClick={() => {
                  setCaptainShipId(selectedShipId);
                  setRole("captain");
                }}
                type="button"
              >
                Cpt
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:h-[calc(100vh-49px)] lg:overflow-hidden lg:grid-cols-[280px_1fr_320px] xl:grid-cols-[300px_1fr_340px]">
        {/* ── Fleet list ── */}
        <aside className="flex flex-col overflow-hidden border-b border-white/6 bg-[#07151a] lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/6">
            <span className="text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">
              Fleet
            </span>
            <span className="font-mono text-[10px] text-slate-600">
              {formatTime(snapshot.serverTime)}
            </span>
          </div>
          <div className="thin-scroll max-h-48 overflow-y-auto lg:max-h-none lg:flex-1">
            {listedShips.map((ship) => {
              const sc = statusColor(ship.status);
              const dotColor =
                sc === "emerald"
                  ? "bg-emerald-400"
                  : sc === "amber"
                    ? "bg-amber-400"
                    : "bg-red-400";
              const selected = selectedShipId === ship.id;
              return (
                <button
                  className={`w-full px-4 py-2.5 text-left transition-colors duration-100 border-b border-white/4 ${
                    selected ? "bg-cyan-400/10" : "hover:bg-white/4"
                  }`}
                  key={ship.id}
                  onClick={() => {
                    if (role === "command") {
                      setSelectedShipId(ship.id);
                      setCaptainShipId(ship.id);
                    }
                  }}
                  type="button"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`}
                      />
                      <span
                        className={`text-sm font-medium ${selected ? "text-cyan-300" : "text-slate-200"}`}
                      >
                        {ship.name}
                      </span>
                    </span>
                    <span className="font-mono text-xs text-slate-500">
                      {ship.speedKnots.toFixed(0)}kt ·{" "}
                      {ship.fuelTons.toFixed(0)}t
                    </span>
                  </div>
                  <FuelBar fuel={ship.fuelTons} className="mt-1.5 ml-3.5" />
                </button>
              );
            })}
          </div>
        </aside>

        {/* ── Map ── */}
        <section className="map-scanlines bg-[#061018] flex flex-col">
          <svg
            className="w-full"
            style={{
              minHeight: 260,
              flex: "1 1 0%",
              cursor: drawingMode ? "crosshair" : "default",
            }}
            viewBox={mapViewBox}
            role="img"
            preserveAspectRatio="xMidYMid meet"
            ref={svgRef}
            onClick={handleMapClick}
            onMouseMove={handleMapMouseMove}
            onMouseLeave={() => setMouseMapPos(null)}
          >
            <defs>
              <pattern
                id="grid"
                width="50"
                height="50"
                patternUnits="userSpaceOnUse"
              >
                <path
                  d="M 50 0 L 0 0 0 50"
                  fill="none"
                  stroke="rgba(148,163,184,0.06)"
                  strokeWidth="1"
                />
              </pattern>
              <radialGradient id="mapVignette" cx="50%" cy="50%" r="70%">
                <stop offset="0%" stopColor="transparent" />
                <stop offset="100%" stopColor="rgba(5,13,18,0.6)" />
              </radialGradient>
              <filter id="glow">
                <feGaussianBlur stdDeviation="2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="#061822" />
            <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#grid)" />

            {/* Navigable bounds (operating area bounding box) */}
            {(() => {
              const bb = snapshot.boundingBox;
              const [x0, y0] = project([bb.north, bb.west]);
              const [x1, y1] = project([bb.south, bb.east]);
              return (
                <rect
                  fill="none"
                  height={y1 - y0}
                  stroke="rgba(251,191,36,0.55)"
                  strokeDasharray="12 6"
                  strokeWidth="1.5"
                  width={x1 - x0}
                  x={x0}
                  y={y0}
                />
              );
            })()}

            {/* Navigable water */}
            <polygon
              fill="rgba(6,182,212,0.07)"
              points={snapshot.navigableWater
                .map((p) => project(p).join(","))
                .join(" ")}
              stroke="rgba(6,182,212,0.35)"
              strokeWidth="1.5"
            />

            {/* Restricted zones */}
            {snapshot.restrictedZones.map((zone) => (
              <polygon
                fill="rgba(239,68,68,0.15)"
                key={zone.id}
                points={zone.polygon.map((p) => project(p).join(",")).join(" ")}
                stroke="rgba(248,113,113,0.85)"
                strokeDasharray="8 5"
                strokeWidth="2"
              />
            ))}

            {/* Zone draw overlay */}
            {drawingMode && (
              <g>
                {draftPolygon.length > 1 && (
                  <polyline
                    fill="none"
                    points={draftPolygon
                      .map((p) => project(p).join(","))
                      .join(" ")}
                    stroke="rgba(239,68,68,0.85)"
                    strokeDasharray="6 3"
                    strokeWidth="2"
                  />
                )}
                {mouseMapPos && draftPolygon.length > 0 && (
                  <line
                    stroke="rgba(239,68,68,0.45)"
                    strokeDasharray="4 3"
                    strokeWidth="1.5"
                    x1={project(draftPolygon[draftPolygon.length - 1])[0]}
                    x2={mouseMapPos[0]}
                    y1={project(draftPolygon[draftPolygon.length - 1])[1]}
                    y2={mouseMapPos[1]}
                  />
                )}
                {draftPolygon.map((p, i) => {
                  const [x, y] = project(p);
                  const isFirst = i === 0 && draftPolygon.length >= 3;
                  return (
                    <circle
                      key={i}
                      cx={x}
                      cy={y}
                      fill={
                        isFirst ? "rgba(239,68,68,0.9)" : "rgba(239,68,68,0.6)"
                      }
                      r={isFirst ? 9 : 5}
                      stroke="white"
                      strokeWidth="1.5"
                      style={isFirst ? { cursor: "pointer" } : undefined}
                    />
                  );
                })}
              </g>
            )}

            {/* Weather samples */}
            {snapshot.weatherSamples.map((sample) => {
              const [x, y] = project(sample.position);
              return (
                <g key={sample.id}>
                  <circle
                    cx={x}
                    cy={y}
                    fill={
                      sample.adverse
                        ? "rgba(244,63,94,0.12)"
                        : "rgba(6,182,212,0.08)"
                    }
                    r={sample.adverse ? 44 : 30}
                    stroke={
                      sample.adverse
                        ? "rgba(251,113,133,0.7)"
                        : "rgba(6,182,212,0.45)"
                    }
                    strokeDasharray={sample.adverse ? "6 4" : "0"}
                    strokeWidth="1.5"
                  />
                  <text
                    fill={
                      sample.adverse
                        ? "rgba(252,165,165,0.9)"
                        : "rgba(103,232,249,0.8)"
                    }
                    fontSize="10"
                    x={x + 8}
                    y={y - 8}
                  >
                    {sample.adverse ? "⚠ +30% fuel" : "clear"}
                  </text>
                </g>
              );
            })}

            {/* Routes — only selected ship */}
            {renderedShips
              .filter((ship) => ship.id === selectedShipId)
              .map((ship) => {
                const pts = ship.currentRoute.waypoints
                  .map((p) => project(p).join(","))
                  .join(" ");
                if (!pts) return null;
                return (
                  <polyline
                    fill="none"
                    key={`route-${ship.id}`}
                    points={pts}
                    stroke="rgba(6,182,212,0.9)"
                    strokeWidth="2"
                  />
                );
              })}

            {/* Ports */}
            {snapshot.ports.map((port) => {
              const [x, y] = project(port.position);
              return (
                <g key={port.id}>
                  <rect
                    fill="#bef264"
                    height="8"
                    width="8"
                    x={x - 4}
                    y={y - 4}
                    opacity="0.9"
                  />
                  <text
                    fill="#bef264"
                    fontSize="11"
                    opacity="0.85"
                    x={x + 7}
                    y={y + 4}
                  >
                    {port.name}
                  </text>
                </g>
              );
            })}

            {/* Ships */}
            {renderedShips.map((ship) => {
              const [x, y] = project(ship.position);
              const sel = ship.id === selectedShipId;
              const sc = statusColor(ship.status);
              const strokeClr =
                sc === "emerald"
                  ? "#042f2e"
                  : sc === "amber"
                    ? "#92400e"
                    : "#7f1d1d";

              return (
                <g
                  className="cursor-pointer"
                  key={ship.id}
                  onClick={() => {
                    if (role === "command") {
                      setSelectedShipId(ship.id);
                      setCaptainShipId(ship.id);
                    }
                  }}
                >
                  {sel && (
                    <circle
                      cx={x}
                      cy={y}
                      r="22"
                      fill="none"
                      stroke="rgba(6,182,212,0.2)"
                      strokeWidth="1"
                    />
                  )}
                  <g
                    transform={`translate(${x} ${y}) rotate(${ship.headingDegrees})`}
                    filter={sel ? "url(#glow)" : undefined}
                  >
                    <path
                      d="M 0 -11 L 7 9 L 0 5 L -7 9 Z"
                      fill={
                        sel
                          ? "#22d3ee"
                          : sc === "amber"
                            ? "#fbbf24"
                            : sc === "red"
                              ? "#f87171"
                              : "#e2e8f0"
                      }
                      stroke={strokeClr}
                      strokeWidth="1.5"
                    />
                  </g>
                  <text
                    fill={sel ? "#22d3ee" : "rgba(148,163,184,0.7)"}
                    fontSize={sel ? "11" : "9"}
                    fontWeight={sel ? "700" : "500"}
                    textAnchor="middle"
                    x={x}
                    y={y - (sel ? 26 : 20)}
                    letterSpacing="0.5"
                    style={{ pointerEvents: "none" }}
                  >
                    {sel ? ship.name : ship.id}
                  </text>
                </g>
              );
            })}

            {/* North arrow — anchored to top-left of the tight viewBox */}
            <g transform={`translate(${mapOriginX + 28},${mapOriginY + 28})`}>
              <circle
                cx="0"
                cy="0"
                r="16"
                fill="rgba(5,13,18,0.7)"
                stroke="rgba(6,182,212,0.25)"
                strokeWidth="1"
              />
              <path d="M 0 -10 L 3.5 4 L 0 2 L -3.5 4 Z" fill="#e2e8f0" />
              <text
                fill="#64748b"
                fontSize="8"
                fontWeight="700"
                textAnchor="middle"
                x="0"
                y="20"
              >
                N
              </text>
            </g>

            {/* Vignette overlay */}
            <rect
              width={MAP_WIDTH}
              height={MAP_HEIGHT}
              fill="url(#mapVignette)"
              style={{ pointerEvents: "none" }}
            />
          </svg>

          {/* Map status bar */}
          <div className="flex shrink-0 items-center gap-0 border-t border-white/6 bg-black/40 text-[10px] text-slate-500 uppercase tracking-wider backdrop-blur-sm">
            <span className="border-r border-white/6 px-3 py-2 text-emerald-400">
              ● SSE 1Hz
            </span>
            <span className="border-r border-white/6 px-3 py-2">
              Interp active
            </span>
            <span className="border-r border-white/6 px-3 py-2">
              {renderedShips.length} routes
            </span>
            <span className="border-r border-white/6 px-3 py-2">
              {snapshot.weatherSamples.length} wx
            </span>
            <span className="border-r border-white/6 px-3 py-2">
              {snapshot.restrictedZones.length} zones
            </span>
            <span
              className={
                activeAlerts.length > 0 ? "px-3 py-2 text-red-400" : "px-3 py-2"
              }
            >
              {activeAlerts.length} alerts
            </span>
          </div>
        </section>

        {/* ── Right panel ── */}
        <aside className="thin-scroll flex flex-col overflow-y-auto border-t border-white/6 bg-[#07151a] lg:border-t-0 lg:border-l">
          {role === "command" ? (
            <>
              {/* Playback controls */}
              <div className="border-b border-white/6 p-4">
                <p className="mb-3 text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">
                  Playback
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => setPlaybackIndex(null)}
                    size="sm"
                    type="button"
                    variant={!inPlayback ? "default" : "ghost"}
                  >
                    Live
                  </Button>
                  <Button
                    disabled={snapshot.history.length === 0}
                    onClick={() => {
                      if (snapshot.history.length > 0) {
                        setPlaybackIndex(playbackIndex ?? 0);
                      }
                    }}
                    size="sm"
                    type="button"
                    variant={inPlayback ? "default" : "outline"}
                  >
                    Review
                  </Button>
                </div>
                <input
                  className="mt-3 w-full accent-cyan-400"
                  disabled={snapshot.history.length === 0}
                  max={Math.max(0, snapshot.history.length - 1)}
                  min={0}
                  onChange={(event) =>
                    setPlaybackIndex(Number(event.target.value))
                  }
                  type="range"
                  value={playbackCursor}
                />
                <p className="mt-2 text-[10px] text-slate-500">
                  {inPlayback && playbackFrame
                    ? `Viewing ${formatTime(playbackFrame.timestamp)} (${playbackCursor}/${Math.max(
                        0,
                        snapshot.history.length - 1,
                      )})`
                    : `Live mode (${snapshot.history.length} history points available)`}
                </p>
              </div>

              {/* Selected Ship */}
              <div className="border-b border-white/6 p-4">
                <p className="mb-3 text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">
                  Selected Ship
                </p>
                {selectedShip && (
                  <>
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div>
                        <p className="text-base font-bold text-white leading-tight">
                          {selectedShip.name}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          {selectedShip.id} · {selectedShip.cargo}
                        </p>
                      </div>
                      <span
                        className={`mt-0.5 shrink-0 rounded px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest ${
                          statusColor(selectedShip.status) === "emerald"
                            ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
                            : statusColor(selectedShip.status) === "amber"
                              ? "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30"
                              : "bg-red-500/15 text-red-300 ring-1 ring-red-500/30"
                        }`}
                      >
                        {formatStatus(selectedShip.status)}
                      </span>
                    </div>
                    <div className="mb-3">
                      <div className="mb-1 flex justify-between text-[10px]">
                        <span className="text-slate-600 uppercase tracking-wider">
                          Fuel
                        </span>
                        <span className="font-mono text-slate-400">
                          {selectedShip.fuelTons.toFixed(0)} t
                        </span>
                      </div>
                      <FuelBar fuel={selectedShip.fuelTons} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        ["Speed", `${selectedShip.speedKnots.toFixed(1)} kt`],
                        [
                          "Heading",
                          `${selectedShip.headingDegrees.toFixed(0)}° ${toCardinal(selectedShip.headingDegrees)}`,
                        ],
                        ["Dest", destName(selectedShip.destinationPortId)],
                      ].map(([label, val]) => (
                        <div
                          key={label}
                          className={label === "Dest" ? "col-span-2" : ""}
                        >
                          <p className="text-[9px] uppercase tracking-wider text-slate-600">
                            {label}
                          </p>
                          <p className="mt-0.5 font-mono text-sm text-slate-200">
                            {val}
                          </p>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Directive */}
              <div className="border-b border-white/6 p-4">
                <p className="mb-3 text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">
                  Directive
                </p>
                <form onSubmit={issueDirective} className="flex flex-col gap-2">
                  <select
                    className="w-full border border-white/8 bg-[#050d12] px-3 py-2 text-sm text-slate-200 focus:border-cyan-400/40 focus:outline-none"
                    onChange={(e) =>
                      setDirectiveType(e.target.value as DirectiveType)
                    }
                    value={directiveType}
                  >
                    {Object.entries(directiveLabels).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  {directiveType === "CHANGE_SPEED" && (
                    <input
                      className="w-full border border-white/8 bg-[#050d12] px-3 py-2 text-sm text-slate-200 focus:border-cyan-400/40 focus:outline-none"
                      max={28}
                      min={0}
                      type="number"
                      value={speedKnots}
                      onChange={(e) => setSpeedKnots(Number(e.target.value))}
                    />
                  )}
                  {directiveType === "REROUTE_PORT" && (
                    <select
                      className="w-full border border-white/8 bg-[#050d12] px-3 py-2 text-sm text-slate-200 focus:border-cyan-400/40 focus:outline-none"
                      onChange={(e) => setDestinationPortId(e.target.value)}
                      value={destinationPortId}
                    >
                      {snapshot.ports.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    className="w-full uppercase tracking-widest text-xs"
                    disabled={inPlayback}
                    type="submit"
                  >
                    Issue to {selectedShip?.name}
                  </Button>
                  {drawingMode ? (
                    <div className="space-y-1.5">
                      <p className="text-center text-[10px] text-red-300">
                        {draftPolygon.length < 3
                          ? `Click map to add vertices (${draftPolygon.length}/3 min)`
                          : `${draftPolygon.length} pts — click first dot or Save to close`}
                      </p>
                      <div className="flex gap-1.5">
                        <Button
                          className="flex-1 text-xs"
                          disabled={draftPolygon.length < 3}
                          onClick={submitDrawnZone}
                          type="button"
                          variant="destructive"
                        >
                          Save Zone
                        </Button>
                        <Button
                          className="flex-1 text-xs"
                          onClick={cancelDrawing}
                          type="button"
                          variant="outline"
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-1.5">
                      <Button
                        className="flex-1 text-xs"
                        disabled={inPlayback}
                        onClick={() => setDrawingMode(true)}
                        type="button"
                        variant="destructive"
                      >
                        Draw Zone
                      </Button>
                      <Button
                        className="flex-1 text-xs"
                        disabled={inPlayback}
                        onClick={createZoneAroundShip}
                        type="button"
                        variant="outline"
                      >
                        Box Ship
                      </Button>
                    </div>
                  )}
                </form>
              </div>

              {/* Zone editing */}
              <div className="border-b border-white/6 p-4">
                <p className="mb-3 text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">
                  Zone Editing
                </p>
                {snapshot.restrictedZones.length === 0 ? (
                  <p className="text-xs text-slate-600">
                    No restricted zones yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {snapshot.restrictedZones.map((zone) => (
                      <div
                        className="flex items-center justify-between border border-white/8 p-2"
                        key={zone.id}
                      >
                        <div>
                          <p className="text-xs text-slate-200">{zone.name}</p>
                          <p className="text-[10px] text-slate-600">
                            {zone.active ? "active" : "inactive"}
                          </p>
                        </div>
                        <Button
                          disabled={inPlayback}
                          onClick={() => setZoneActive(zone.id, !zone.active)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {zone.active ? "Deactivate" : "Activate"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Alerts */}
              <div className="flex flex-1 flex-col p-4">
                <div className="mb-3 flex items-center gap-2">
                  <p className="text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">
                    Alerts
                  </p>
                  {activeAlerts.length > 0 && (
                    <span className="rounded bg-red-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                      {activeAlerts.length}
                    </span>
                  )}
                </div>
                {activeAlerts.length === 0 ? (
                  <p className="text-xs text-slate-600">No active alerts.</p>
                ) : (
                  <div className="space-y-2">
                    {activeAlerts.map((alert) => (
                      <div
                        className={`border p-3 text-xs ${severityClass(alert.severity)}`}
                        key={alert.id}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="leading-snug">{alert.message}</p>
                          <Button
                            className="shrink-0"
                            disabled={inPlayback}
                            onClick={() =>
                              postJson("/api/sim/alerts/ack", {
                                alertId: alert.id,
                              })
                            }
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Ack
                          </Button>
                        </div>
                        <p className="mt-1.5 text-[10px] opacity-50">
                          {alert.type} · {formatTime(alert.createdAt)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {/* Captain Console */}
              <div className="border-b border-white/6 p-4">
                <p className="mb-3 text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">
                  Captain Console
                </p>
                {captainShip && (
                  <>
                    <p className="text-base font-bold text-white">
                      {captainShip.name}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {captainShip.id}
                    </p>
                    <div className="mt-3 mb-1 flex justify-between text-[10px]">
                      <span className="uppercase tracking-wider text-slate-600">
                        Fuel
                      </span>
                      <span className="font-mono text-slate-400">
                        {captainShip.fuelTons.toFixed(0)} t
                      </span>
                    </div>
                    <FuelBar fuel={captainShip.fuelTons} />
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                      {[
                        ["Status", formatStatus(captainShip.status)],
                        ["Speed", `${captainShip.speedKnots.toFixed(1)} kt`],
                        [
                          "Heading",
                          `${captainShip.headingDegrees.toFixed(0)}° ${toCardinal(captainShip.headingDegrees)}`,
                        ],
                        ["Dest", destName(captainShip.destinationPortId)],
                        ["Cargo", captainShip.cargo],
                      ].map(([label, val]) => (
                        <div key={label}>
                          <p className="text-[9px] uppercase tracking-wider text-slate-600">
                            {label}
                          </p>
                          <p className="mt-0.5 font-mono text-slate-200 truncate">
                            {val}
                          </p>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3 text-[10px] text-slate-600">
                      Scoped to {captainShip.id}.
                    </p>
                  </>
                )}
              </div>

              {/* Pending Directives */}
              <div className="border-b border-white/6 p-4">
                <p className="mb-3 text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">
                  Pending Directives
                </p>
                {pendingCaptainDirectives.length === 0 ? (
                  <p className="text-xs text-slate-600">
                    No directives awaiting response.
                  </p>
                ) : (
                  pendingCaptainDirectives.map((directive) => (
                    <div
                      className="border border-white/8 p-3"
                      key={directive.id}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-semibold text-slate-200">
                          {directiveLabels[directive.type]}
                        </span>
                        <span className="font-mono text-[10px] text-slate-600">
                          {formatTime(directive.issuedAt)}
                        </span>
                      </div>
                      <textarea
                        className="h-20 w-full border border-white/8 bg-black/20 p-2 text-xs text-slate-200 focus:border-cyan-400/40 focus:outline-none"
                        onChange={(e) => setDistressMessage(e.target.value)}
                        value={distressMessage}
                      />
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <Button
                          className="w-full text-xs uppercase tracking-wider bg-emerald-400 text-slate-950 hover:bg-emerald-300"
                          disabled={inPlayback}
                          onClick={() =>
                            respondToDirective(directive.id, "ACCEPT")
                          }
                          type="button"
                        >
                          Accept
                        </Button>
                        <Button
                          className="w-full text-xs"
                          disabled={inPlayback}
                          onClick={() =>
                            respondToDirective(
                              directive.id,
                              "ESCALATE_DISTRESS",
                            )
                          }
                          type="button"
                          variant="destructive"
                        >
                          Escalate
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Visible Zones */}
              <div className="p-4">
                <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.25em] text-slate-500">
                  Visible Zones
                </p>
                <p className="text-xs text-slate-600">
                  {snapshot.restrictedZones.length} command zone
                  {snapshot.restrictedZones.length !== 1 ? "s" : ""} — read
                  only.
                </p>
              </div>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}
