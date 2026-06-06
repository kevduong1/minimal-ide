/**
 * Stable per-project accent colors. Each project (workspace path) is assigned
 * an index into the `--project-N` palette (styles/theme.css) on first ask and
 * keeps it forever — across restarts (localStorage) and for agent terminals
 * whose project isn't currently open. The active project's color is applied
 * app-wide by overriding `--accent` on the .app root (App.tsx); the rest of
 * the accent family derives from it via color-mix in theme.css.
 *
 * Assignments never change once made, so render-time reads need no store —
 * the lazy first-assignment write below is synchronous and idempotent.
 */

/** Must match the number of `--project-N` variables in theme.css. */
const PALETTE_SIZE = 8;

const STORAGE_KEY = "minimal-ide:project-colors";
/** Growth bound: oldest assignments are dropped past this (colors for repos
    not touched in ages may eventually rotate — acceptable). */
const MAX_ASSIGNMENTS = 64;

interface PersistedColors {
  version: 1;
  /** Insertion-ordered path → palette index. */
  assignments: Record<string, number>;
}

const loadAssignments = (): Map<string, number> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as PersistedColors;
    if (parsed.version !== 1) return new Map();
    return new Map(
      Object.entries(parsed.assignments).filter(
        ([, i]) => Number.isInteger(i) && i >= 0 && i < PALETTE_SIZE,
      ),
    );
  } catch {
    return new Map();
  }
};

const assignments = loadAssignments();

const save = () => {
  const data: PersistedColors = {
    version: 1,
    assignments: Object.fromEntries(assignments),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
};

/**
 * The project's palette index, assigned on first ask: the least-used index
 * among existing assignments (ties → lowest), so open projects stay visually
 * distinct until the palette is exhausted.
 */
export function projectColorIndex(path: string): number {
  const existing = assignments.get(path);
  if (existing !== undefined) return existing;

  const counts = new Array<number>(PALETTE_SIZE).fill(0);
  for (const i of assignments.values()) counts[i]++;
  const index = counts.indexOf(Math.min(...counts));

  assignments.set(path, index);
  while (assignments.size > MAX_ASSIGNMENTS) {
    // Map iteration is insertion-ordered — first key = oldest assignment.
    assignments.delete(assignments.keys().next().value!);
  }
  save();
  return index;
}

/** CSS color for the project, as a theme-palette var() reference. */
export const projectColorVar = (path: string): string =>
  `var(--project-${projectColorIndex(path)})`;
