/**
 * Pure layout-tree model shared by both terminal docks: the global agent
 * dock (stores/agentTerminals) and each workspace's terminal dock
 * (stores/terminal). A dock is a tree of splits (row/column, fractional
 * sizes) whose leaves are tab groups; every operation here is a pure
 * state-in/state-out function — no zustand, no xterm, no IPC.
 *
 * No-op convention: operations return the INPUT state object (same
 * reference) when nothing changed, so stores can bail without re-rendering.
 */

export interface DockTerminalBase {
  id: string;
  /** Display title (tab label; renameable). */
  title: string;
}

/** "row" = children left→right, "column" = children top→bottom. */
export type SplitDirection = "row" | "column";

export interface DockGroup {
  type: "group";
  id: string;
  /** Tab order, left → right. Never empty after normalize. */
  terminalIds: string[];
  activeTerminalId: string;
}

export interface DockSplit {
  type: "split";
  id: string;
  direction: SplitDirection;
  /** Invariant (post-normalize): length ≥ 2, no same-direction child split. */
  children: DockNode[];
  /** Fractions of the split's axis; same length as children, sum ≈ 1. */
  sizes: number[];
}

export type DockNode = DockGroup | DockSplit;
export type DropEdge = "left" | "right" | "top" | "bottom";

export interface DockState<T extends DockTerminalBase> {
  terminals: Record<string, T>;
  /** Layout tree; null = empty dock. */
  root: DockNode | null;
  /** Group receiving new terminals; valid iff root is non-null. */
  activeGroupId: string | null;
}

/** Smallest fraction a split child may occupy (resizer clamp). */
export const MIN_FRACTION = 0.05;

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

export const dockGroups = (
  node: DockNode | null,
  out: DockGroup[] = [],
): DockGroup[] => {
  if (!node) return out;
  if (node.type === "group") out.push(node);
  else for (const c of node.children) dockGroups(c, out);
  return out;
};

export const findGroup = (
  node: DockNode | null,
  id: string | null | undefined,
): DockGroup | null =>
  id ? (dockGroups(node).find((g) => g.id === id) ?? null) : null;

export const groupOf = (
  node: DockNode | null,
  terminalId: string,
): DockGroup | null =>
  dockGroups(node).find((g) => g.terminalIds.includes(terminalId)) ?? null;

export const findSplit = (
  node: DockNode | null,
  id: string,
): DockSplit | null => {
  if (!node || node.type === "group") return null;
  if (node.id === id) return node;
  for (const c of node.children) {
    const found = findSplit(c, id);
    if (found) return found;
  }
  return null;
};

/** Rebuild the tree with every group passed through `fn` (immutable). */
const mapGroups = (node: DockNode, fn: (g: DockGroup) => DockGroup): DockNode =>
  node.type === "group"
    ? fn(node)
    : { ...node, children: node.children.map((c) => mapGroups(c, fn)) };

/**
 * Restore the tree invariants after any structural change (post-order):
 *  - a group with no tabs is removed;
 *  - a split drops removed children and renormalizes its fractions;
 *  - a split left with one child is replaced by that child;
 *  - a child split with the SAME direction is inlined (its fractions scaled
 *    by the child's own fraction) — without this, repeated edge-splits build
 *    degenerate nesting: row[A, row[B, C]] resizes exactly like the flat
 *    row[A, B, C], but stacks two resizers on one boundary and grows the
 *    tree unboundedly. Inlining also makes splitGroup trivial: wrapping a
 *    group in a same-direction split normalizes into "insert adjacent at
 *    half the target's fraction" (e.g. row[A:.5, B:.5] + drop on B's left
 *    edge → row[A:.5, row[N:.5, B:.5]:.5] → row[A:.5, N:.25, B:.25]);
 *  - a group's activeTerminalId is forced back into its tabs.
 */
export const normalize = (node: DockNode | null): DockNode | null => {
  if (!node) return null;
  if (node.type === "group") {
    if (node.terminalIds.length === 0) return null;
    return node.terminalIds.includes(node.activeTerminalId)
      ? node
      : { ...node, activeTerminalId: node.terminalIds[0] };
  }
  const children: DockNode[] = [];
  const sizes: number[] = [];
  const equalShare = 1 / Math.max(node.children.length, 1);
  node.children.forEach((child, i) => {
    const c = normalize(child);
    if (!c) return;
    const size = node.sizes[i] ?? equalShare;
    if (c.type === "split" && c.direction === node.direction) {
      c.children.forEach((gc, j) => {
        children.push(gc);
        sizes.push(size * (c.sizes[j] ?? 1 / c.children.length));
      });
    } else {
      children.push(c);
      sizes.push(size);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const sum = sizes.reduce((a, b) => a + b, 0);
  return {
    ...node,
    children,
    sizes:
      sum > 0 ? sizes.map((s) => s / sum) : children.map(() => 1 / children.length),
  };
};

/** Keep activeGroupId pointing at a live group (prefer `preferred`). */
const fixActiveGroup = (
  root: DockNode | null,
  current: string | null,
  preferred?: string,
): string | null => {
  const all = dockGroups(root);
  if (preferred && all.some((g) => g.id === preferred)) return preferred;
  if (current && all.some((g) => g.id === current)) return current;
  return all[0]?.id ?? null;
};

/**
 * Remove a tab from a group; the group's active tab falls to the
 * index-clamped next neighbor. May produce an empty group — normalize
 * prunes it before anything reads the (then-meaningless) activeTerminalId.
 */
const removeFromGroup = (g: DockGroup, terminalId: string): DockGroup => {
  const idx = g.terminalIds.indexOf(terminalId);
  if (idx === -1) return g;
  const terminalIds = g.terminalIds.filter((t) => t !== terminalId);
  const activeTerminalId =
    g.activeTerminalId === terminalId
      ? (terminalIds[Math.min(idx, terminalIds.length - 1)] ?? "")
      : g.activeTerminalId;
  return { ...g, terminalIds, activeTerminalId };
};

/** Wrap one group in a new split pairing it with `add` (see normalize). */
const wrapGroup = (
  node: DockNode,
  groupId: string,
  add: DockGroup,
  direction: SplitDirection,
  addFirst: boolean,
): DockNode => {
  if (node.type === "group") {
    if (node.id !== groupId) return node;
    return {
      type: "split",
      id: crypto.randomUUID(),
      direction,
      children: addFirst ? [add, node] : [node, add],
      sizes: [0.5, 0.5],
    };
  }
  return {
    ...node,
    children: node.children.map((c) =>
      wrapGroup(c, groupId, add, direction, addFirst),
    ),
  };
};

// ---------------------------------------------------------------------------
// State operations (each returns the input state by reference on no-ops)
// ---------------------------------------------------------------------------

/**
 * Register a terminal and place its tab: in `groupId` when given and alive,
 * else the active group, else the first group, else a new root group. The
 * new tab becomes its group's active tab and that group the active group.
 */
export function addTerminal<T extends DockTerminalBase>(
  s: DockState<T>,
  terminal: T,
  groupId?: string | null,
): DockState<T> {
  const terminals = { ...s.terminals, [terminal.id]: terminal };
  const target =
    findGroup(s.root, groupId) ??
    findGroup(s.root, s.activeGroupId) ??
    dockGroups(s.root)[0] ??
    null;
  if (!target) {
    const group: DockGroup = {
      type: "group",
      id: crypto.randomUUID(),
      terminalIds: [terminal.id],
      activeTerminalId: terminal.id,
    };
    return { terminals, root: group, activeGroupId: group.id };
  }
  return {
    terminals,
    root: mapGroups(s.root!, (g) =>
      g.id === target.id
        ? {
            ...g,
            terminalIds: [...g.terminalIds, terminal.id],
            activeTerminalId: terminal.id,
          }
        : g,
    ),
    activeGroupId: target.id,
  };
}

/** Structural removal of a terminal (PTY disposal is the caller's job). */
export function removeTerminal<T extends DockTerminalBase>(
  s: DockState<T>,
  id: string,
): DockState<T> {
  if (!s.terminals[id]) return s;
  const terminals = { ...s.terminals };
  delete terminals[id];
  const root = s.root
    ? normalize(mapGroups(s.root, (g) => removeFromGroup(g, id)))
    : null;
  return { terminals, root, activeGroupId: fixActiveGroup(root, s.activeGroupId) };
}

/** Activates both the tab within its group and the group itself. */
export function setActiveTerminal<T extends DockTerminalBase>(
  s: DockState<T>,
  groupId: string,
  terminalId: string,
): DockState<T> {
  const g = findGroup(s.root, groupId);
  if (!g || !g.terminalIds.includes(terminalId)) return s;
  if (g.activeTerminalId === terminalId && s.activeGroupId === groupId) return s;
  return {
    terminals: s.terminals,
    root: mapGroups(s.root!, (gg) =>
      gg.id === groupId ? { ...gg, activeTerminalId: terminalId } : gg,
    ),
    activeGroupId: groupId,
  };
}

export function setActiveGroup<T extends DockTerminalBase>(
  s: DockState<T>,
  groupId: string,
): DockState<T> {
  if (s.activeGroupId === groupId || !findGroup(s.root, groupId)) return s;
  return { terminals: s.terminals, root: s.root, activeGroupId: groupId };
}

/** Trims; ignores empty/whitespace titles (callers pick the fallback). */
export function renameTerminal<T extends DockTerminalBase>(
  s: DockState<T>,
  id: string,
  title: string,
): DockState<T> {
  const t = s.terminals[id];
  const trimmed = title.trim();
  if (!t || !trimmed || t.title === trimmed) return s;
  return {
    terminals: { ...s.terminals, [id]: { ...t, title: trimmed } },
    root: s.root,
    activeGroupId: s.activeGroupId,
  };
}

/**
 * Move a tab into targetGroup at `index` (clamped). Within one group this
 * is a reorder; a net-unchanged position is an exact no-op. Cross-group,
 * the moved tab becomes the target's active tab and the target becomes the
 * active group; an emptied source group dissolves.
 */
export function moveTerminal<T extends DockTerminalBase>(
  s: DockState<T>,
  terminalId: string,
  targetGroupId: string,
  index: number,
): DockState<T> {
  const target = findGroup(s.root, targetGroupId);
  const source = groupOf(s.root, terminalId);
  if (!target || !source) return s;

  if (source.id === target.id) {
    // Reorder. The drop index counts the tab still sitting in the strip,
    // so removal shifts insertion points to its right down by one.
    const cur = target.terminalIds.indexOf(terminalId);
    const ids = target.terminalIds.filter((t) => t !== terminalId);
    const at = Math.max(0, Math.min(index > cur ? index - 1 : index, ids.length));
    ids.splice(at, 0, terminalId);
    if (ids.every((t, i) => t === target.terminalIds[i])) return s; // no-op drop
    return {
      terminals: s.terminals,
      root: mapGroups(s.root!, (g) =>
        g.id === target.id ? { ...g, terminalIds: ids } : g,
      ),
      activeGroupId: target.id,
    };
  }

  const root = normalize(
    mapGroups(s.root!, (g) => {
      if (g.id === source.id) return removeFromGroup(g, terminalId);
      if (g.id === target.id) {
        const ids = [...g.terminalIds];
        ids.splice(Math.max(0, Math.min(index, ids.length)), 0, terminalId);
        return { ...g, terminalIds: ids, activeTerminalId: terminalId };
      }
      return g;
    }),
  );
  return {
    terminals: s.terminals,
    root,
    activeGroupId: fixActiveGroup(root, s.activeGroupId, target.id),
  };
}

/**
 * Tear terminalId out into a NEW group on `edge` of targetGroup (splitting
 * in that axis; left/top = new group first). No-op when the terminal is the
 * target's only tab (the layout would be unchanged). The new group takes
 * half of the target's space and becomes active.
 */
export function splitGroup<T extends DockTerminalBase>(
  s: DockState<T>,
  terminalId: string,
  targetGroupId: string,
  edge: DropEdge,
): DockState<T> {
  const target = findGroup(s.root, targetGroupId);
  const source = groupOf(s.root, terminalId);
  if (!target || !source) return s;
  // Splitting a group off of itself using its only tab recreates the exact
  // same layout — refuse so a sloppy drop isn't a tree churn.
  if (source.id === target.id && source.terminalIds.length === 1) return s;

  const newGroup: DockGroup = {
    type: "group",
    id: crypto.randomUUID(),
    terminalIds: [terminalId],
    activeTerminalId: terminalId,
  };
  const direction: SplitDirection =
    edge === "left" || edge === "right" ? "row" : "column";
  const addFirst = edge === "left" || edge === "top";

  let root: DockNode | null = mapGroups(s.root!, (g) =>
    g.id === source.id ? removeFromGroup(g, terminalId) : g,
  );
  root = normalize(wrapGroup(root, targetGroupId, newGroup, direction, addFirst));
  return {
    terminals: s.terminals,
    root,
    activeGroupId: fixActiveGroup(root, s.activeGroupId, newGroup.id),
  };
}

/** Resizer drags. Length must match children; clamped + renormalized. */
export function setSplitSizes<T extends DockTerminalBase>(
  s: DockState<T>,
  splitId: string,
  sizes: number[],
): DockState<T> {
  if (!s.root) return s;
  let changed = false;
  const fix = (node: DockNode): DockNode => {
    if (node.type === "group") return node;
    const children = node.children.map(fix);
    if (node.id === splitId && sizes.length === children.length) {
      changed = true;
      const clamped = sizes.map((x) =>
        Number.isFinite(x) ? Math.max(MIN_FRACTION, x) : MIN_FRACTION,
      );
      const sum = clamped.reduce((a, b) => a + b, 0);
      return { ...node, children, sizes: clamped.map((x) => x / sum) };
    }
    return children.some((c, i) => c !== node.children[i])
      ? { ...node, children }
      : node;
  };
  const root = fix(s.root);
  if (!changed) return s;
  return { terminals: s.terminals, root, activeGroupId: s.activeGroupId };
}

// ---------------------------------------------------------------------------
// Persistence sanitizer (used by docks that save their tree)
// ---------------------------------------------------------------------------

/**
 * Rebuild a trustworthy tree from persisted JSON: unknown node shapes are
 * dropped, tab references are restricted to known terminals and deduped
 * across the whole tree (first reference wins; collect into `seen`), sizes
 * are repaired. Callers normalize() the result and drop unseen terminals.
 */
export const sanitizeNode = (
  raw: unknown,
  terminals: Record<string, DockTerminalBase>,
  seen: Set<string>,
): DockNode | null => {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (n.type === "group" && typeof n.id === "string" && Array.isArray(n.terminalIds)) {
    const ids: string[] = [];
    for (const t of n.terminalIds) {
      if (typeof t === "string" && terminals[t] && !seen.has(t)) {
        seen.add(t);
        ids.push(t);
      }
    }
    if (ids.length === 0) return null;
    const active =
      typeof n.activeTerminalId === "string" && ids.includes(n.activeTerminalId)
        ? n.activeTerminalId
        : ids[0];
    return { type: "group", id: n.id, terminalIds: ids, activeTerminalId: active };
  }
  if (n.type === "split" && typeof n.id === "string" && Array.isArray(n.children)) {
    const children: DockNode[] = [];
    const sizes: number[] = [];
    (n.children as unknown[]).forEach((c, i) => {
      const sc = sanitizeNode(c, terminals, seen);
      if (!sc) return;
      const size = Array.isArray(n.sizes) ? n.sizes[i] : undefined;
      children.push(sc);
      sizes.push(typeof size === "number" && size > 0 && Number.isFinite(size) ? size : 1);
    });
    if (children.length === 0) return null;
    return {
      type: "split",
      id: n.id,
      direction: n.direction === "column" ? "column" : "row",
      children,
      sizes,
    };
  }
  return null;
};
