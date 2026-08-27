"use client";

import { createClient } from "@/lib/supabase/client";
import type { FarmEvent, FarmState, PastureCell, Paddock } from "@grazingcattle/game-types";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EVENTS_SHOWN = 50;
const CELL_PX = 48;       // pixel size of each grid cell
const GRID_GAP = 2;       // gap between cells
const PADDOCK_GAP = 6;    // extra gap between paddock blocks (2×2 groups)
const HALF = 2;           // cells per paddock side (GRID_SIZE / 2)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isLive = (status: string) =>
  status !== "dead" && status !== "sold" && status !== "slaughtered";

const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

// Grass colour: brown (bare) → yellow-green → bright green (full)
const grassColor = (biomass: number, max: number): string => {
  const t = max > 0 ? Math.min(1, biomass / max) : 0;
  // 0 → #6b4226 (bare soil), 0.5 → #a8c040 (sparse), 1 → #3a8c1a (lush)
  const r = Math.round(107 + (58 - 107) * t);
  const g = Math.round(66 + (140 - 66) * t);
  const b = Math.round(38 + (26 - 38) * t);
  return `rgb(${r},${g},${b})`;
};

// Converts grid (x, y) → canvas pixel origin for that cell
const cellToPixel = (x: number, y: number) => {
  const px = x * (CELL_PX + GRID_GAP) + (x >= HALF ? PADDOCK_GAP : 0);
  const py = y * (CELL_PX + GRID_GAP) + (y >= HALF ? PADDOCK_GAP : 0);
  return { px, py };
};

// Reverse: canvas click → grid (x, y)
const pixelToCell = (cx: number, cy: number): { x: number; y: number } | null => {
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const { px, py } = cellToPixel(x, y);
      if (cx >= px && cx < px + CELL_PX && cy >= py && cy < py + CELL_PX) {
        return { x, y };
      }
    }
  }
  return null;
};

const paddockStats = (farm: FarmState, paddock: Paddock) => {
  const ids = new Set(paddock.cellIds);
  const cells = farm.cells.filter((c) => ids.has(c.id));
  const liveCows = farm.cows.filter((c) => isLive(c.status) && c.currentPaddockId === paddock.id);
  return {
    cowCount: liveCows.length,
    meanGrass: mean(cells.map((c) => c.grassBiomassKgHa)),
    meanRoots: mean(cells.map((c) => c.rootHealth)),
    meanSoil:  mean(cells.map((c) => c.soilHealth)),
    maxGrass:  mean(cells.map((c) => c.maxBiomassKgHa)),
  };
};

const farmOverview = (farm: FarmState) => {
  const live = farm.cows.filter((c) => isLive(c.status));
  return {
    herdSize: live.length,
    avgBcs:   mean(live.map((c) => c.bodyConditionScore)),
    avgGrass: mean(farm.cells.map((c) => c.grassBiomassKgHa)),
    avgRoots: mean(farm.cells.map((c) => c.rootHealth)),
    avgSoil:  mean(farm.cells.map((c) => c.soilHealth)),
  };
};

const expectedWeightForAge = (matureWeightKg: number, ageDays: number) =>
  Math.round(matureWeightKg * (0.064 + 0.936 * Math.min(1, ageDays / 730)));

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const CANVAS_SIZE =
  4 * CELL_PX + 3 * GRID_GAP + PADDOCK_GAP; // total canvas width/height

const FarmCanvas = ({
  farm,
  selectedPaddockId,
  onSelectPaddock,
}: {
  farm: FarmState;
  selectedPaddockId: string | null;
  onSelectPaddock: (id: string) => void;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Build a lookup: cellId → paddockId
  const cellPaddock = new Map<string, string>();
  for (const p of farm.paddocks) {
    for (const cid of p.cellIds) cellPaddock.set(cid, p.id);
  }

  // Build a lookup: "x,y" → cell
  const cellByXY = new Map<string, PastureCell>();
  for (const c of farm.cells) cellByXY.set(`${c.x},${c.y}`, c);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const cell = cellByXY.get(`${x},${y}`);
        const { px, py } = cellToPixel(x, y);

        // Fill with grass colour
        ctx.fillStyle = cell
          ? grassColor(cell.grassBiomassKgHa, cell.maxBiomassKgHa)
          : "#555";
        ctx.fillRect(px, py, CELL_PX, CELL_PX);

        // Highlight selected paddock with a white border
        if (cell) {
          const pid = cellPaddock.get(cell.id);
          if (pid && pid === selectedPaddockId) {
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2;
            ctx.strokeRect(px + 1, py + 1, CELL_PX - 2, CELL_PX - 2);
          }
        }

        // Pixel-art style: tiny 1px inner shadow on bottom-right
        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.fillRect(px, py + CELL_PX - 1, CELL_PX, 1);
        ctx.fillRect(px + CELL_PX - 1, py, 1, CELL_PX);

        // Cow dot if any live cows are in this paddock
        if (cell) {
          const pid = cellPaddock.get(cell.id);
          const cowsHere = pid
            ? farm.cows.filter((c) => isLive(c.status) && c.currentPaddockId === pid)
            : [];
          if (cowsHere.length > 0) {
            ctx.fillStyle = "#fff";
            ctx.font = `${Math.round(CELL_PX * 0.38)}px serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("🐄", px + CELL_PX / 2, py + CELL_PX / 2);
          }
        }
      }
    }
  });

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const gridPos = pixelToCell(cx, cy);
    if (!gridPos) return;
    const cell = cellByXY.get(`${gridPos.x},${gridPos.y}`);
    if (!cell) return;
    const pid = cellPaddock.get(cell.id);
    if (pid) onSelectPaddock(pid);
  };

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_SIZE}
      height={CANVAS_SIZE}
      onClick={handleClick}
      style={{ cursor: "pointer", imageRendering: "pixelated", display: "block" }}
    />
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const S = {
  page: {
    fontFamily: "monospace",
    background: "#1a1a1a",
    minHeight: "100vh",
    color: "#e8e8e8",
  } as CSSProperties,

  header: {
    background: "#111",
    borderBottom: "2px solid #333",
    padding: "10px 20px",
    display: "flex",
    alignItems: "center",
    gap: 24,
    flexWrap: "wrap" as const,
  } as CSSProperties,

  headerTitle: { fontSize: 16, fontWeight: 700, color: "#c8e6a0", letterSpacing: 1 } as CSSProperties,
  headerStat: { fontSize: 13, color: "#aaa" } as CSSProperties,
  headerVal:  { color: "#e8e8e8", fontWeight: 600 } as CSSProperties,

  body: {
    display: "grid",
    gridTemplateColumns: `${CANVAS_SIZE}px 1fr`,
    gridTemplateRows: "auto 1fr",
    gap: 0,
    height: "calc(100vh - 49px)",
  } as CSSProperties,

  leftCol: {
    background: "#222",
    borderRight: "2px solid #333",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "flex-start",
    padding: 16,
    gap: 16,
  } as CSSProperties,

  rightCol: {
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
  } as CSSProperties,

  panel: {
    padding: "12px 16px",
    borderBottom: "1px solid #333",
  } as CSSProperties,

  panelTitle: { fontSize: 11, fontWeight: 700, color: "#7a9a5a", letterSpacing: 2, marginBottom: 8, textTransform: "uppercase" as const } as CSSProperties,

  table: { borderCollapse: "collapse" as const, width: "100%", fontSize: 12 } as CSSProperties,
  th: { padding: "4px 10px", textAlign: "left" as const, color: "#777", fontWeight: 400, borderBottom: "1px solid #333" } as CSSProperties,
  td: { padding: "5px 10px", borderBottom: "1px solid #2a2a2a" } as CSSProperties,

  btn: {
    border: "1px solid #555",
    borderRadius: 3,
    padding: "5px 12px",
    background: "#2a2a2a",
    color: "#ccc",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 12,
  } as CSSProperties,

  select: {
    background: "#2a2a2a",
    border: "1px solid #555",
    borderRadius: 3,
    color: "#ccc",
    fontFamily: "monospace",
    fontSize: 12,
    padding: "3px 6px",
  } as CSSProperties,

  eventsList: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "8px 16px",
    fontSize: 11,
    color: "#777",
    lineHeight: 1.8,
  } as CSSProperties,
};

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function DevPage() {
  const router = useRouter();
  const [farm, setFarm] = useState<FarmState | null>(null);
  const [events, setEvents] = useState<FarmEvent[]>([]);
  const [catchUpHours, setCatchUpHours] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPaddockId, setSelectedPaddockId] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => { void initialLoad(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const initialLoad = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/farms");
      if (!res.ok) throw new Error(`Load failed: ${res.status}`);
      const data: { farm: FarmState; events: FarmEvent[]; catchUpHours: number } = await res.json();
      setFarm(data.farm);
      setEvents(data.events.slice(0, MAX_EVENTS_SHOWN));
      setCatchUpHours(data.catchUpHours);
      setSelectedPaddockId(data.farm.paddocks[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const advance = async (hours: number) => {
    if (!farm || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/farms/${farm.id}/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours }),
      });
      if (!res.ok) throw new Error(`Step failed: ${res.status}`);
      const data: { farm: FarmState; events: FarmEvent[] } = await res.json();
      setFarm(data.farm);
      setEvents(data.events.slice(0, MAX_EVENTS_SHOWN));
      setCatchUpHours(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  const moveHerd = async (targetPaddockId: string) => {
    if (!farm || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/api/farms/${farm.id}/move-herd`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPaddockId }),
      });
      if (!res.ok) throw new Error(`Move failed: ${res.status}`);
      const data: { farm: FarmState } = await res.json();
      setFarm(data.farm);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  const moveCow = async (cowId: string, targetPaddockId: string) => {
    if (!farm || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/api/farms/${farm.id}/move-cow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cowId, targetPaddockId }),
      });
      if (!res.ok) throw new Error(`Move failed: ${res.status}`);
      const data: { farm: FarmState; events: FarmEvent[] } = await res.json();
      setFarm(data.farm);
      setEvents(data.events.slice(0, MAX_EVENTS_SHOWN));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  const sellCow = async (cowId: string) => {
    if (!farm || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const res = await fetch(`/api/farms/${farm.id}/sell-cow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cowId }),
      });
      if (!res.ok) throw new Error(`Sell failed: ${res.status}`);
      const data: { farm: FarmState; event: FarmEvent } = await res.json();
      setFarm(data.farm);
      setEvents((prev) => [data.event, ...prev].slice(0, MAX_EVENTS_SHOWN));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  const signOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  };

  if (!farm && loading) {
    return <div style={{ ...S.page, padding: 24 }}>Loading farm…</div>;
  }

  if (!farm) {
    return <div style={{ ...S.page, padding: 24, color: "red" }}>Error: {error}</div>;
  }

  const day = Math.floor(farm.simHour / 24) + 1;
  const ov = farmOverview(farm);
  const liveCows = farm.cows.filter((c) => isLive(c.status));
  const selectedPaddock = farm.paddocks.find((p) => p.id === selectedPaddockId) ?? farm.paddocks[0]!;
  const selStats = paddockStats(farm, selectedPaddock);
  const selCows = liveCows.filter((c) => c.currentPaddockId === selectedPaddock.id);

  return (
    <div style={S.page}>
      {/* ── Header ── */}
      <header style={S.header}>
        <span style={S.headerTitle}>🐄 GRAZING CATTLE</span>
        <span style={S.headerStat}>Day <span style={S.headerVal}>{day}</span></span>
        <span style={S.headerStat}><span style={S.headerVal}>{farm.season}</span></span>
        <span style={S.headerStat}><span style={S.headerVal}>{farm.weatherToday.temperatureC.toFixed(0)}°C</span> · <span style={S.headerVal}>{farm.weatherToday.rainfallMm.toFixed(1)}mm</span></span>
        <span style={S.headerStat}>Herd <span style={S.headerVal}>{ov.herdSize}</span></span>
        <span style={S.headerStat}>Avg BCS <span style={S.headerVal}>{ov.avgBcs.toFixed(1)}</span></span>
        <span style={S.headerStat}>Avg grass <span style={S.headerVal}>{ov.avgGrass.toFixed(0)} kg/ha</span></span>
        <span style={S.headerStat}>Avg roots <span style={S.headerVal}>{ov.avgRoots.toFixed(2)}</span></span>
        <span style={S.headerStat}>Avg soil <span style={S.headerVal}>{ov.avgSoil.toFixed(2)}</span></span>
        <span style={S.headerStat}>💰 <span style={S.headerVal}>${farm.moneyUsd.toFixed(0)}</span></span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button style={S.btn} onClick={() => advance(24)} disabled={loading}>+1d</button>
          <button style={S.btn} onClick={() => advance(24 * 7)} disabled={loading}>+7d</button>
          <button style={S.btn} onClick={() => advance(24 * 30)} disabled={loading}>+30d</button>
          <button style={{ ...S.btn, marginLeft: 8, color: "#999" }} onClick={signOut}>Sign out</button>
        </div>
      </header>

      {catchUpHours > 0 && (
        <div style={{ background: "#2a2200", borderBottom: "1px solid #554400", padding: "6px 20px", fontSize: 12, color: "#c8a040" }}>
          While you were away, {(catchUpHours / 24).toFixed(1)} farm days passed. See events below.
        </div>
      )}
      {error && (
        <div style={{ background: "#2a0000", borderBottom: "1px solid #550000", padding: "6px 20px", fontSize: 12, color: "#f08080" }}>
          Error: {error}
        </div>
      )}
      {loading && (
        <div style={{ background: "#111", borderBottom: "1px solid #333", padding: "4px 20px", fontSize: 11, color: "#555" }}>
          Simulating…
        </div>
      )}

      {/* ── Main body: left = map, right = panels ── */}
      <div style={S.body}>

        {/* Left: pixel map + move-herd control */}
        <div style={S.leftCol}>
          <div>
            <div style={S.panelTitle}>Farm map</div>
            <FarmCanvas
              farm={farm}
              selectedPaddockId={selectedPaddock.id}
              onSelectPaddock={setSelectedPaddockId}
            />
            <div style={{ marginTop: 8, fontSize: 11, color: "#555" }}>
              Click a tile to select its paddock
            </div>
          </div>

          {/* Paddock summary */}
          <div style={{ width: "100%" }}>
            <div style={S.panelTitle}>All paddocks</div>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Paddock</th>
                  <th style={S.th}>Cows</th>
                  <th style={S.th}>Grass</th>
                  <th style={S.th}>Roots</th>
                  <th style={S.th}>Soil</th>
                </tr>
              </thead>
              <tbody>
                {farm.paddocks.map((p) => {
                  const s = paddockStats(farm, p);
                  const isSelected = p.id === selectedPaddock.id;
                  return (
                    <tr
                      key={p.id}
                      onClick={() => setSelectedPaddockId(p.id)}
                      style={{
                        cursor: "pointer",
                        background: isSelected ? "#2a3a1a" : "transparent",
                      }}
                    >
                      <td style={{ ...S.td, color: isSelected ? "#c8e6a0" : "#aaa" }}>{p.name}</td>
                      <td style={S.td}>{s.cowCount}</td>
                      <td style={S.td}>{s.meanGrass.toFixed(0)}</td>
                      <td style={S.td}>{s.meanRoots.toFixed(2)}</td>
                      <td style={S.td}>{s.meanSoil.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Move entire herd */}
          <div>
            <div style={S.panelTitle}>Move herd</div>
            <div style={{ display: "flex", gap: 6 }}>
              {farm.paddocks.map((p) => (
                <button
                  key={p.id}
                  style={{ ...S.btn, background: p.id === selectedPaddock.id ? "#3a5a2a" : "#2a2a2a" }}
                  disabled={loading}
                  onClick={() => moveHerd(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: selected paddock detail + events */}
        <div style={S.rightCol}>
          {/* Selected paddock header */}
          <div style={S.panel}>
            <div style={S.panelTitle}>{selectedPaddock.name} — detail</div>
            <div style={{ display: "flex", gap: 24, fontSize: 13 }}>
              <span>Grass <strong>{selStats.meanGrass.toFixed(0)}</strong><span style={{ color: "#555" }}> / {selStats.maxGrass.toFixed(0)} kg/ha</span></span>
              <span>Root health <strong>{selStats.meanRoots.toFixed(2)}</strong><span style={{ color: "#555" }}> / 1.0</span></span>
              <span>Soil <strong>{selStats.meanSoil.toFixed(2)}</strong><span style={{ color: "#555" }}> / 1.0</span></span>
              <span>Cows <strong>{selStats.cowCount}</strong></span>
            </div>
          </div>

          {/* Cows in selected paddock */}
          <div style={{ ...S.panel, flex: 1, overflowY: "auto" }}>
            <div style={S.panelTitle}>Cows in {selectedPaddock.name} ({selCows.length})</div>
            {selCows.length === 0 ? (
              <div style={{ color: "#555", fontSize: 12 }}>No live cows in this paddock.</div>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>ID</th>
                    <th style={S.th}>Status</th>
                    <th style={S.th}>Sex</th>
                    <th style={S.th}>Age</th>
                    <th style={S.th}>Weight</th>
                    <th style={S.th}>BCS</th>
                    <th style={S.th}>Pregnant</th>
                    <th style={S.th}>Move to</th>
                    <th style={S.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {selCows.map((cow) => {
                    const isAdult = cow.ageDays >= 730;
                    const expWeight = isAdult
                      ? cow.matureWeightKg
                      : expectedWeightForAge(cow.matureWeightKg, cow.ageDays);
                    const bcs = cow.bodyConditionScore;
                    const isCalf = cow.status === "calf";
                    const rowBg = isCalf ? "transparent"
                      : bcs < 3.0 ? "#2a0a0a"
                      : bcs < 3.5 ? "#2a1e00"
                      : "transparent";
                    const daysLeft = cow.pregnant && cow.pregnancyDays != null
                      ? Math.max(0, Math.ceil(283 - cow.pregnancyDays))
                      : null;
                    return (
                      <tr key={cow.id} style={{ background: rowBg }}>
                        <td style={{ ...S.td, color: "#888", fontSize: 10 }}>{cow.id.slice(-6)}</td>
                        <td style={S.td}>{cow.status}</td>
                        <td style={S.td}>{cow.sex === "male" ? "♂" : "♀"}</td>
                        <td style={S.td}>{(cow.ageDays / 365).toFixed(1)}yr</td>
                        <td style={S.td}>
                          {cow.weightKg.toFixed(0)}
                          <span style={{ color: "#555" }}> / {expWeight}kg</span>
                          {!isAdult && <span style={{ color: "#555", fontSize: 10 }}> (exp)</span>}
                        </td>
                        <td style={S.td}>
                          {bcs.toFixed(1)}
                          {!isCalf && bcs < 3.0 && <span style={{ color: "#f07070", marginLeft: 4 }}>⚠ dying</span>}
                          {!isCalf && bcs >= 3.0 && bcs < 3.5 && <span style={{ color: "#c09040", marginLeft: 4 }}>⚠ risk</span>}
                        </td>
                        <td style={S.td}>
                          {daysLeft !== null
                            ? <span style={{ color: "#c8a040" }}>🐄 {daysLeft}d</span>
                            : <span style={{ color: "#444" }}>—</span>}
                        </td>
                        <td style={S.td}>
                          <select
                            defaultValue={cow.currentPaddockId ?? ""}
                            onChange={(e) => moveCow(cow.id, e.target.value)}
                            disabled={loading}
                            style={S.select}
                          >
                            {farm.paddocks.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                        </td>
                        <td style={S.td}>
                          <button style={S.btn} onClick={() => sellCow(cow.id)} disabled={loading}>Sell</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Events log */}
          <div style={{ borderTop: "2px solid #333", display: "flex", flexDirection: "column", maxHeight: 200 }}>
            <div style={{ ...S.panel, paddingBottom: 4 }}>
              <div style={S.panelTitle}>Events</div>
            </div>
            <div style={S.eventsList}>
              {events.length === 0 && <div>None yet.</div>}
              {events.map((e) => (
                <div key={e.id} style={{ marginBottom: 2 }}>
                  <span style={{ color: "#555" }}>day {Math.floor(e.simHour / 24) + 1}</span>
                  {" — "}
                  <span style={{ color: "#9ab870" }}>{e.type}</span>
                  {" — "}
                  <span>{JSON.stringify(e.data)}</span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
