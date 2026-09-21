export interface PhaseStatus {
  running: boolean;
  phase: "idle" | "work" | "break";
  remaining_secs: number;
  cycle: number;
}

export function formatClock(secs: number): string {
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}
