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

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

use base64::Engine as _;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{Emitter, Manager};

pub struct PtySession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
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
    // Masquerade as a notification-capable terminal: agent CLIs (Claude Code
    // & friends) only emit OSC 9 / OSC 777 notification sequences when they
    // recognize TERM_PROGRAM. The frontend (lib/terminalActivity.ts) turns
    // those into needs-attention indicators on terminal and workspace tabs.
    // Known cost: TERM_PROGRAM-sniffing tools (chafa, yazi, ...) may assume
    // Kitty graphics support and emit images xterm.js silently drops.
    cmd.env("TERM_PROGRAM", "ghostty");
    cmd.env("TERM_PROGRAM_VERSION", "1.2.0");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave fd is owned by the child now; close our copy.
    drop(pair.slave);

    let master = pair.master;
    let writer = master.take_writer().map_err(|e| e.to_string())?;
    let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    // Register the session before the reader thread starts so an immediate
    // exit can't race the insertion.
    state.sessions.lock().insert(
        id.clone(),
        PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master,
            killer,
        },
    );

    std::thread::spawn(move || {
        let mut reader = reader;
        let mut child = child;
        let mut buf = [0u8; 32768];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let payload = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app.emit(&format!("pty-data:{id}"), payload);
                }
            }
        }
        // Reap the child (kill() alone leaves a zombie until wait()).
        let code: Option<i32> = child.wait().ok().map(|status| status.exit_code() as i32);
        let _ = app.emit(&format!("pty-exit:{id}"), code);
        app.state::<PtyState>().sessions.lock().remove(&id);
    });

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

#[tauri::command]
pub async fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut session = state.sessions.lock().remove(&id).ok_or("unknown pty")?;
    // Killing the child closes its side of the PTY, which unblocks and ends
    // the reader thread (EOF); the reader thread then reaps it via wait().
    let _ = session.killer.kill();
    Ok(())
}
