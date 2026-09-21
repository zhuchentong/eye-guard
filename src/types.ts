export interface PhaseStatus {
  running: boolean;
  phase: "idle" | "work" | "break";
  remaining_secs: number;
  cycle: number;
  /** phase === "break" 时：本次是否为长休息 */
  long_break: boolean;
}

export function formatClock(secs: number): string {
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}
