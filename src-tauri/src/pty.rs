//! PTY sessions for the integrated terminal.
//!
//! Each terminal pane owns one `PtySession`, keyed by a frontend-generated id.
//! Output is streamed to the webview as base64 chunks on `pty-data:<id>`;
//! process exit is signalled on `pty-exit:<id>` with an `Option<i32>` code.
//!
//! Locking: the global session map is only ever held for map lookups —
//! never across a blocking PTY write — so one wedged terminal (full kernel
//! buffer, stopped reader) can never stall the other sessions or the IPC
//! runtime. Each writer has its own lock and writes run on the blocking pool.
//!
//! Flow control: webview event dispatch has no backpressure of its own, so a
//! chatty child (`yes`, a huge `cat`) could flood the main thread with more
//! base64 than xterm can parse and freeze the UI. The reader thread counts
//! emitted-but-unacknowledged bytes and parks above FLOW_HIGH_WATER; the
//! frontend acks via `pty_ack` from xterm's write-completion callback.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use parking_lot::{Condvar, Mutex};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{Emitter, Manager};

/// Park the reader thread once this many emitted bytes are unacknowledged
/// (~1 MiB ≈ a few hundred ms of xterm parse work — snappy to recover, far
/// too small to freeze the UI).
const FLOW_HIGH_WATER: usize = 1 << 20;
/// How long pty_kill's SIGHUP gets to work before the process group is
/// SIGKILLed.
const KILL_GRACE: Duration = Duration::from_millis(500);

/// Consumption-side flow control shared by a session and its reader thread.
#[derive(Default)]
struct Flow {
    state: Mutex<FlowState>,
    cond: Condvar,
}

#[derive(Default)]
struct FlowState {
    /// Bytes emitted to the webview that the frontend hasn't parsed yet.
    unacked: usize,
    /// Session killed — unparks (and stops) a flow-parked reader.
    closed: bool,
}

pub struct PtySession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    flow: Arc<Flow>,
    /// Shell pid — doubles as its process-group id (spawned via setsid).
    pid: Option<u32>,
    /// Set by the reader thread once the child has been reaped.
    exited: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    agent: bool,
) -> Result<(), String> {
    if state.sessions.lock().contains_key(&id) {
        // A duplicate id would orphan the existing shell and let its reader
        // thread remove the new session from the map on exit.
        return Err(format!("pty id already in use: {id}"));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // CommandBuilder inherits the app's environment, and in dev the app
    // itself may have been launched from a real terminal whose identity
    // would otherwise leak into every pane (LC_TERMINAL=iTerm2 alongside our
    // TERM_PROGRAM, live ITERM_SESSION_IDs, ...). Scrub the whole identity
    // family — a pane is not that terminal.
    for var in [
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "TERM_SESSION_ID",
        "ITERM_SESSION_ID",
        "ITERM_PROFILE",
        "LC_TERMINAL",
        "LC_TERMINAL_VERSION",
        "GHOSTTY_RESOURCES_DIR",
        "GHOSTTY_BIN_DIR",
        "KITTY_WINDOW_ID",
        "KITTY_PID",
        "KITTY_PUBLIC_KEY",
        "KITTY_INSTALLATION_DIR",
        "WEZTERM_EXECUTABLE",
        "WEZTERM_CONFIG_FILE",
        "WEZTERM_CONFIG_DIR",
        "WEZTERM_PANE",
        "WEZTERM_UNIX_SOCKET",
    ] {
        cmd.env_remove(var);
    }
    if agent {
        // Masquerade as a notification-capable terminal: agent CLIs (Claude
        // Code & friends) only emit OSC 9 / OSC 777 notification sequences
        // when they recognize TERM_PROGRAM. The frontend
        // (lib/terminalActivity.ts) turns those into needs-attention
        // indicators on terminal and workspace tabs. Known cost:
        // TERM_PROGRAM-sniffing tools (chafa, yazi, ...) may assume Kitty
        // graphics support and emit images xterm.js silently drops — which is
        // why plain panes don't masquerade.
        cmd.env("TERM_PROGRAM", "ghostty");
        cmd.env("TERM_PROGRAM_VERSION", "1.2.0");
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave fd is owned by the child now; close our copy.
    drop(pair.slave);

    let master = pair.master;
    let writer = master.take_writer().map_err(|e| e.to_string())?;
    let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let pid = child.process_id();
    let flow = Arc::new(Flow::default());
    let exited = Arc::new(AtomicBool::new(false));

    // Register the session before the reader thread starts so an immediate
    // exit can't race the insertion.
    state.sessions.lock().insert(
        id.clone(),
        PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master,
            killer,
            flow: flow.clone(),
            pid,
            exited: exited.clone(),
        },
    );

    std::thread::spawn(move || {
        let mut reader = reader;
        let mut child = child;
        let mut buf = [0u8; 32768];
        'read: loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // Count BEFORE emitting: an ack racing ahead of the
                    // increment would be clamped away by saturating_sub and
                    // leave phantom unacked bytes behind forever.
                    flow.state.lock().unacked += n;
                    let payload = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app.emit(&format!("pty-data:{id}"), payload);
                    // Flow control: park until the frontend has parsed most
                    // of what we already sent (or the session is killed).
                    let mut st = flow.state.lock();
                    while st.unacked >= FLOW_HIGH_WATER {
                        if st.closed {
                            break 'read;
                        }
                        flow.cond.wait(&mut st);
                    }
                }
            }
        }
        // Reap the child (kill() alone leaves a zombie until wait()).
        let code: Option<i32> = child.wait().ok().map(|status| status.exit_code() as i32);
        exited.store(true, Ordering::Release);
        let _ = app.emit(&format!("pty-exit:{id}"), code);
        app.state::<PtyState>().sessions.lock().remove(&id);
    });

    Ok(())
}

/// Frontend acknowledgement that `bytes` of output were parsed by xterm —
/// the reader thread's licence to keep streaming. Late acks for an exited
/// session return Err("unknown pty"); callers ignore it.
#[tauri::command]
pub async fn pty_ack(
    state: tauri::State<'_, PtyState>,
    id: String,
    bytes: usize,
) -> Result<(), String> {
    let flow = {
        let sessions = state.sessions.lock();
        sessions.get(&id).ok_or("unknown pty")?.flow.clone()
    };
    let mut st = flow.state.lock();
    st.unacked = st.unacked.saturating_sub(bytes);
    flow.cond.notify_one();
    Ok(())
}

#[tauri::command]
pub async fn pty_write(
    state: tauri::State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    // Clone the per-session writer handle out of the map so the global lock
    // is released before the (potentially blocking) write.
    let writer = {
        let sessions = state.sessions.lock();
        sessions.get(&id).ok_or("unknown pty")?.writer.clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut w = writer.lock();
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions.get(&id).ok_or("unknown pty")?;
    // resize is a fast ioctl; holding the map lock here is fine.
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Tear a session down: unpark its reader, SIGHUP the shell, escalate.
fn kill_session(mut session: PtySession) {
    // Unpark a flow-parked reader so it can wind down and reap.
    {
        let mut st = session.flow.state.lock();
        st.closed = true;
        session.flow.cond.notify_all();
    }
    // SIGHUP first — the shell exits cleanly, HUPs its jobs, runs zlogout —
    // which closes the child side of the PTY and ends the reader thread
    // (EOF); the reader then reaps via wait(). But portable-pty's killer
    // sends a single SIGHUP with no escalation, so a HUP-trapping foreground
    // child (nginx, a HUP-ignoring daemon) would survive, keep the slave fd
    // open, and wedge the reader forever: escalate to SIGKILL on the shell's
    // process group after a grace period. The pid can't be recycled in the
    // meantime — the child stays unreaped (a zombie at worst) until the
    // reader thread wait()s it, and `exited` only flips after that.
    let _ = session.killer.kill();
    let pid = session.pid;
    let exited = session.exited.clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(KILL_GRACE);
        if let Some(pid) = pid {
            if !exited.load(Ordering::Acquire) {
                // The shell is a session leader (setsid), so its pid doubles
                // as the process-group id; -pgid signals the whole group.
                unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
            }
        }
    });
}

/// Kill every live session. Called when the webview (re)loads its page: a
/// reload loses all frontend pane state, so the sessions are unreachable —
/// nothing will ever ack them again, and a flow-parked reader would
/// otherwise stay parked forever, freezing its child mid-write.
pub fn kill_all(state: &PtyState) {
    let sessions: Vec<PtySession> = {
        let mut map = state.sessions.lock();
        map.drain().map(|(_, s)| s).collect()
    };
    for session in sessions {
        kill_session(session);
    }
}

#[tauri::command]
pub async fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    let session = state.sessions.lock().remove(&id).ok_or("unknown pty")?;
    kill_session(session);
    Ok(())
}
