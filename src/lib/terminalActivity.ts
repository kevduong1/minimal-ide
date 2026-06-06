/**
 * Per-pane terminal activity tracking: classifies a pane as busy (a command
 * or agent is producing output) and/or needing attention (it rang the bell,
 * sent a notification, or went quiet while the user was away — e.g. Claude
 * Code stopping to ask a question).
 *
 * Detection is heuristic because stock zsh emits no shell-integration marks:
 *  - busy: sustained output that isn't keystroke echo. Silent commands
 *    (`sleep 5`) are intentionally missed — better than a spinner that can
 *    get stuck on. Alternate-screen TUIs (vim, htop) repaint constantly
 *    without "working" in any meaningful sense, so they never count.
 *  - attention: BEL / OSC 9 / OSC 777 notifications (pty.rs masquerades as a
 *    notification-capable TERM_PROGRAM so agent CLIs actually send these),
 *    plus a busy stretch ≥ ATTENTION_MIN_BUSY_MS ending while the pane was
 *    unwatched ("finished or wants input while you were away"). A stretch
 *    only "ends" once quiet survives PING_GRACE_MS — bursty jobs whose
 *    output merely stalls resume within it and keep their original stretch.
 *    Attention clears when the user types in or clicks into the pane
 *    (acknowledge) — never from the output path: xterm fires onWriteParsed
 *    for the very chunk that delivered a notification, and onData also fires
 *    for terminal-generated replies (focus reports, DA/CPR responses), so
 *    both must be guarded or a ping would wipe itself before being seen.
 *
 * When OSC 133/633 semantic-prompt marks ARE present (iTerm2 / VS Code shell
 * integration sourced in the user's zshrc), they own busy/idle exactly and
 * the output heuristic stands down — until marks go stale mid-stream (e.g.
 * an ssh session with remote integration ended), which falls back.
 */
import type { Terminal } from "@xterm/xterm";
import type { PaneActivity } from "../stores/terminal";

/** Output this soon after a keystroke is treated as echo, not work. */
const ECHO_MS = 250;
/** The busy indicator drops after this long without output. */
const QUIET_MS = 600;
/** Quiet must survive this long before it counts as "the work ended". */
const PING_GRACE_MS = 3000;
/**
 * Only busy stretches at least this long raise attention when they end
 * unwatched, so short unattended bursts (dev-server rebuilds, the odd log
 * line) don't ping the workspace tab.
 */
const ATTENTION_MIN_BUSY_MS = 5000;
/** Output with no mark for this long = shell integration died; fall back. */
const MARK_STALE_MS = 10_000;
/** Failsafe so integrated busy can't be stranded if the final mark is lost. */
const INTEGRATED_QUIET_MS = 30_000;

export interface ActivityTracker {
  /** User clicked into the pane — acknowledge (clear) any attention. */
  acknowledge(): void;
  dispose(): void;
}

export function trackActivity(
  term: Terminal,
  /** Whether the user is currently looking at this pane. */
  watched: () => boolean,
  /** Fired only when the pane's activity actually changes. */
  onChange: (activity: PaneActivity) => void,
): ActivityTracker {
  let busy = false;
  let attention = false;
  /** Start of the current busy stretch; survives sub-grace output stalls. */
  let busySince = 0;
  let lastOutputAt = 0;
  let lastInputAt = 0;
  let lastMarkAt = 0;
  /** OSC 133/633 marks seen — they own busy/idle, heuristics stand down. */
  let integrated = false;
  /** Skip the onWriteParsed of a chunk that only delivered a notification. */
  let skipWrite = false;
  let quietTimer: number | null = null;
  let pingTimer: number | null = null;

  const update = (nextBusy: boolean, nextAttention: boolean) => {
    if (nextBusy === busy && nextAttention === attention) return;
    busy = nextBusy;
    attention = nextAttention;
    onChange({ busy, attention });
  };

  const stopQuietTimer = () => {
    if (quietTimer !== null) {
      window.clearTimeout(quietTimer);
      quietTimer = null;
    }
  };
  const stopPingTimer = () => {
    if (pingTimer !== null) {
      window.clearTimeout(pingTimer);
      pingTimer = null;
    }
  };
  const armQuietTimer = (ms: number) => {
    stopQuietTimer();
    quietTimer = window.setTimeout(endBusy, ms);
  };

  /**
   * Output stopped (or progress was cleared): the busy indicator drops now,
   * but whether this deserves a ping is decided only once the quiet survives
   * the grace window — output resuming in time cancels it (same stretch).
   */
  const endBusy = () => {
    stopQuietTimer();
    if (!busy) return;
    update(false, attention);
    const stretch = lastOutputAt - busySince;
    stopPingTimer();
    pingTimer = window.setTimeout(() => {
      pingTimer = null;
      if (!watched() && stretch >= ATTENTION_MIN_BUSY_MS) update(busy, true);
    }, PING_GRACE_MS);
  };

  const beginBusy = () => {
    lastOutputAt = Date.now();
    armQuietTimer(QUIET_MS);
    if (busy) return;
    if (pingTimer !== null) stopPingTimer(); // resumed within grace
    else busySince = lastOutputAt; // genuinely new stretch
    update(true, attention);
  };

  const notify = () => {
    // The chunk delivering a notification mustn't also start a busy stretch
    // (which is what its own onWriteParsed would do).
    skipWrite = true;
    if (!watched()) update(busy, true);
  };

  const disposables = [
    term.onWriteParsed(() => {
      if (skipWrite) {
        skipWrite = false;
        return;
      }
      if (integrated) {
        if (Date.now() - lastMarkAt <= MARK_STALE_MS) {
          lastOutputAt = Date.now(); // keep stretch accounting honest
          if (busy) armQuietTimer(INTEGRATED_QUIET_MS); // stranded-busy failsafe
          return;
        }
        integrated = false; // marks died mid-stream — heuristics take over
      }
      if (term.buffer.active.type === "alternate") return;
      if (Date.now() - lastInputAt < ECHO_MS) {
        // Echo can't start a busy stretch, but it keeps one alive.
        if (busy) armQuietTimer(QUIET_MS);
        return;
      }
      beginBusy();
    }),

    term.onData(() => {
      // Real input implies a focused, visible pane — terminal-generated
      // replies (focus reports, DA/CPR responses) don't get to impersonate
      // the user while they're away.
      if (!watched()) return;
      lastInputAt = Date.now();
      // The user responded — whatever wanted them has them now.
      stopPingTimer();
      if (attention) update(busy, false);
    }),

    term.onBell(notify),

    // OSC 133 (FinalTerm/iTerm2) / OSC 633 (VS Code) semantic prompts:
    // C = command output starts, D = command finished, A/B = at the prompt.
    ...[133, 633].map((code) =>
      term.parser.registerOscHandler(code, (data) => {
        const kind = data[0];
        if (kind !== "A" && kind !== "B" && kind !== "C" && kind !== "D") {
          return false;
        }
        integrated = true;
        lastMarkAt = Date.now();
        stopQuietTimer();
        if (kind === "C") {
          if (!busy) busySince = lastMarkAt;
          lastOutputAt = lastMarkAt;
          stopPingTimer();
          armQuietTimer(INTEGRATED_QUIET_MS); // in case the D mark gets lost
          update(true, attention);
        } else {
          // Explicit completion pings immediately — no grace needed — but
          // still only for stretches long enough to matter.
          const ping =
            kind === "D" &&
            busy &&
            !watched() &&
            lastMarkAt - busySince >= ATTENTION_MIN_BUSY_MS;
          update(false, attention || ping);
        }
        return true;
      }),
    ),

    // OSC 9: ConEmu-style progress ("4;<state>;<pct>") or a notification.
    term.parser.registerOscHandler(9, (data) => {
      if (!data.startsWith("4;")) {
        notify();
        return true;
      }
      const state = data.split(";")[1];
      if (state === "2") notify(); // error state
      else if (!integrated) {
        skipWrite = true;
        if (state === "0") endBusy(); // progress cleared = went quiet
        else beginBusy(); // ticking progress keeps busy alive
      }
      return true;
    }),

    // OSC 777: "notify;<title>;<body>" (Claude Code & friends).
    term.parser.registerOscHandler(777, (data) => {
      if (!data.startsWith("notify;")) return false;
      notify();
      return true;
    }),
  ];

  return {
    acknowledge: () => {
      stopPingTimer(); // the user has seen it — don't ping after they leave
      update(busy, false);
    },
    dispose: () => {
      stopQuietTimer();
      stopPingTimer();
      for (const d of disposables) d.dispose();
    },
  };
}
