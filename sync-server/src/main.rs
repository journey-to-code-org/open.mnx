//! `zubra-sync`: the log that `'use collection'` devices share, as one binary.
//!
//! It speaks the same HTTP protocol as `@zubra/sync/server` (docs/sync.md), and keeps the log in
//! the same SQLite table as `sqliteLog()`, so the two are interchangeable, file included:
//!
//!   POST /_zb/sync/push      { changes: [Change] }            → { ok: true }
//!   GET  /_zb/sync/pull?since=<cursor>                        → { changes, cursor }
//!   GET  /_zb/sync/live?since=<cursor>&peer=<id>              → server-sent events: changes, presence
//!   POST /_zb/sync/presence  { room, peer, state | null }     → { ok: true }
//!
//! It has no notion of users: run it behind the app (a reverse proxy at `/_zb/sync`, after the
//! app's own sign-in) or on a trusted network. Posts from a browser are accepted only from the
//! binary's own origin and the `--origin`s given, which also get CORS headers.

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const MOUNT: &str = "/_zb/sync";
const PAGE: i64 = 1000;
const MAX_BODY: u64 = 1 << 20;

struct Options {
    db: String,
    host: String,
    port: u16,
    origins: Vec<String>,
    keep_alive: Duration,
}

fn options() -> Result<Options, String> {
    let mut options = Options {
        db: "sync.db".into(),
        host: "127.0.0.1".into(),
        port: 4000,
        origins: Vec::new(),
        keep_alive: Duration::from_secs(15),
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or(format!("{name} needs a value"));
        match arg.as_str() {
            "--db" => options.db = value("--db")?,
            "--host" => options.host = value("--host")?,
            "--port" => {
                options.port = value("--port")?
                    .parse()
                    .map_err(|_| "--port takes a number".to_string())?
            }
            "--origin" => options.origins.push(value("--origin")?),
            "--keep-alive" => {
                options.keep_alive = Duration::from_millis(
                    value("--keep-alive")?
                        .parse()
                        .map_err(|_| "--keep-alive takes milliseconds".to_string())?,
                )
            }
            "-h" | "--help" => {
                println!("usage: zubra-sync [--db sync.db] [--host 127.0.0.1] [--port 4000] [--origin https://app.example]... [--keep-alive 15000]");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other} (try --help)")),
        }
    }
    Ok(options)
}

/// One live subscriber: where to send its events, and the rooms its peer is in.
struct Listener {
    id: u64,
    peer: String,
    rooms: HashSet<String>,
    events: Sender<String>,
}

struct State {
    db: Mutex<Connection>,
    listeners: Mutex<Vec<Listener>>,
    next: Mutex<u64>,
    origins: Vec<String>,
    keep_alive: Duration,
}

fn main() {
    let options = match options() {
        Ok(options) => options,
        Err(error) => {
            eprintln!("zubra-sync: {error}");
            std::process::exit(2);
        }
    };
    let db = Connection::open(&options.db).unwrap_or_else(|error| {
        eprintln!("zubra-sync: can't open {}: {error}", options.db);
        std::process::exit(1);
    });
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS changes (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            collection TEXT NOT NULL,
            key TEXT NOT NULL,
            field TEXT NOT NULL,
            value TEXT,
            clock TEXT NOT NULL
        )",
    )
    .expect("create the changes table");
    let address = format!("{}:{}", options.host, options.port);
    let server = Server::http(&address).unwrap_or_else(|error| {
        eprintln!("zubra-sync: can't listen on {address}: {error}");
        std::process::exit(1);
    });
    // The port actually bound (for --port 0), so a test or a supervisor can find it.
    println!(
        "zubra-sync listening on http://{} (log: {})",
        server.server_addr(),
        options.db
    );
    let state = Arc::new(State {
        db: Mutex::new(db),
        listeners: Mutex::new(Vec::new()),
        next: Mutex::new(0),
        origins: options.origins,
        keep_alive: options.keep_alive,
    });
    for request in server.incoming_requests() {
        let state = Arc::clone(&state);
        std::thread::spawn(move || handle(&state, request));
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("a valid header")
}

fn request_header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

/// CORS for the allowed origins (so a page on another origin can use the binary directly).
fn cors(state: &State, request: &Request) -> Vec<Header> {
    match request_header(request, "origin") {
        Some(origin) if state.origins.iter().any(|allowed| allowed == origin) => vec![
            header("access-control-allow-origin", origin),
            header("access-control-allow-headers", "content-type"),
            header("access-control-allow-methods", "GET, POST, OPTIONS"),
            header("vary", "origin"),
        ],
        _ => Vec::new(),
    }
}

/// A browser post must come from this origin or an allowed one. No Origin: not a browser.
fn origin_allowed(state: &State, request: &Request) -> bool {
    let Some(origin) = request_header(request, "origin") else {
        return true;
    };
    let host = request_header(request, "host").unwrap_or_default();
    origin == format!("http://{host}")
        || origin == format!("https://{host}")
        || state.origins.iter().any(|allowed| allowed == origin)
}

fn respond_json(request: Request, extra: Vec<Header>, status: u16, value: Value) {
    let mut response = Response::from_string(value.to_string())
        .with_status_code(StatusCode(status))
        .with_header(header("content-type", "application/json"));
    for each in extra {
        response.add_header(each);
    }
    let _ = request.respond(response);
}

fn query<'a>(url: &'a str, name: &str) -> Option<&'a str> {
    let (_, query) = url.split_once('?')?;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (key == name).then_some(value)
    })
}

fn read_json(request: &mut Request) -> Option<Value> {
    let mut body = String::new();
    request
        .as_reader()
        .take(MAX_BODY)
        .read_to_string(&mut body)
        .ok()?;
    serde_json::from_str(&body).ok()
}

fn handle(state: &State, mut request: Request) {
    let url = request.url().to_owned();
    let path = url.split('?').next().unwrap_or_default().to_owned();
    let extra = cors(state, &request);
    if !path.starts_with(&format!("{MOUNT}/")) {
        return respond_json(request, extra, 404, json!({ "error": "Not found" }));
    }
    let route = &path[MOUNT.len()..];
    match (request.method().clone(), route) {
        (Method::Options, _) => {
            let mut response = Response::empty(StatusCode(204));
            for each in extra {
                response.add_header(each);
            }
            let _ = request.respond(response);
        }
        (Method::Post, "/push") => {
            if !origin_allowed(state, &request) {
                return respond_json(
                    request,
                    extra,
                    403,
                    json!({ "error": "Cross-site writes are refused" }),
                );
            }
            let Some(changes) = read_json(&mut request)
                .and_then(|body| body.get("changes").cloned())
                .and_then(|changes| changes.as_array().cloned())
                .filter(|changes| changes.iter().all(valid_change))
            else {
                return respond_json(
                    request,
                    extra,
                    400,
                    json!({ "error": "Expected { changes: [{ collection, key, field, value, clock }] }" }),
                );
            };
            let cursor = match append(state, &changes) {
                Ok(cursor) => cursor,
                Err(error) => {
                    eprintln!("zubra-sync: {error}");
                    return respond_json(
                        request,
                        extra,
                        500,
                        json!({ "error": "Couldn't write the log" }),
                    );
                }
            };
            let cleaned: Vec<Value> = changes.iter().map(clean_change).collect();
            broadcast(
                state,
                "changes",
                &json!({ "changes": cleaned, "cursor": cursor }),
                None,
            );
            respond_json(request, extra, 200, json!({ "ok": true }));
        }
        (Method::Get, "/pull") => {
            let since = query(&url, "since")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            match after(state, since) {
                Ok((changes, cursor)) => respond_json(
                    request,
                    extra,
                    200,
                    json!({ "changes": changes, "cursor": cursor }),
                ),
                Err(error) => {
                    eprintln!("zubra-sync: {error}");
                    respond_json(
                        request,
                        extra,
                        500,
                        json!({ "error": "Couldn't read the log" }),
                    )
                }
            }
        }
        (Method::Post, "/presence") => {
            if !origin_allowed(state, &request) {
                return respond_json(
                    request,
                    extra,
                    403,
                    json!({ "error": "Cross-site writes are refused" }),
                );
            }
            let Some(message) = read_json(&mut request).filter(valid_presence) else {
                return respond_json(
                    request,
                    extra,
                    400,
                    json!({ "error": "Expected { room: \"<collection>/<key>\", peer, state: {…} | null }" }),
                );
            };
            let room = message["room"].as_str().unwrap_or_default().to_owned();
            let peer = message["peer"].as_str().unwrap_or_default().to_owned();
            let clean = json!({ "room": room, "peer": peer, "state": message["state"] });
            {
                let mut listeners = state.listeners.lock().expect("listeners");
                for listener in listeners
                    .iter_mut()
                    .filter(|listener| listener.peer == peer)
                {
                    if message["state"].is_null() {
                        listener.rooms.remove(&room);
                    } else {
                        listener.rooms.insert(room.clone());
                    }
                }
            }
            broadcast(state, "presence", &clean, Some(&peer));
            respond_json(request, extra, 200, json!({ "ok": true }));
        }
        (Method::Post, "/signal") => {
            // WebRTC signaling for one peer, passed on to that peer's live stream.
            if !origin_allowed(state, &request) {
                return respond_json(
                    request,
                    extra,
                    403,
                    json!({ "error": "Cross-site writes are refused" }),
                );
            }
            let Some(message) = read_json(&mut request).filter(valid_signal) else {
                return respond_json(
                    request,
                    extra,
                    400,
                    json!({ "error": "Expected { room, from, to, data: {…} }" }),
                );
            };
            let to = message["to"].as_str().unwrap_or_default().to_owned();
            let clean = json!({ "room": message["room"], "from": message["from"], "to": to, "data": message["data"] });
            let text = event("signal", &clean);
            for listener in state.listeners.lock().expect("listeners").iter() {
                if listener.peer == to {
                    let _ = listener.events.send(text.clone());
                }
            }
            respond_json(request, extra, 200, json!({ "ok": true }));
        }
        (Method::Get, "/live") => live(state, request, &url, extra),
        _ => respond_json(request, extra, 404, json!({ "error": "Not found" })),
    }
}

fn valid_change(change: &Value) -> bool {
    let text = |name: &str| change.get(name).and_then(Value::as_str);
    let clock_ok = text("clock").is_some_and(|clock| {
        let parts: Vec<&str> = clock.splitn(3, '-').collect();
        parts.len() == 3
            && parts[0].len() == 15
            && parts[0].bytes().all(|b| b.is_ascii_digit())
            && parts[1].len() == 5
            && parts[1].bytes().all(|b| b.is_ascii_digit())
            && !parts[2].is_empty()
            && parts[2]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    });
    text("collection").is_some()
        && text("key").is_some()
        && text("field").is_some_and(|field| field != "$clocks")
        && clock_ok
}

fn clean_change(change: &Value) -> Value {
    json!({
        "collection": change["collection"],
        "key": change["key"],
        "field": change["field"],
        "value": change.get("value").cloned().unwrap_or(Value::Null),
        "clock": change["clock"],
    })
}

fn valid_presence(message: &Value) -> bool {
    let room_ok = message
        .get("room")
        .and_then(Value::as_str)
        .is_some_and(|room| room.find('/').is_some_and(|at| at > 0));
    let peer_ok = message
        .get("peer")
        .and_then(Value::as_str)
        .is_some_and(|peer| {
            !peer.is_empty()
                && peer.len() <= 40
                && peer
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        });
    let state = message.get("state").unwrap_or(&Value::Null);
    let state_ok = (state.is_null() || state.is_object()) && state.to_string().len() <= 4096;
    room_ok && peer_ok && state_ok
}

fn peer_ok(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|peer| {
        !peer.is_empty()
            && peer.len() <= 40
            && peer
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

fn valid_signal(message: &Value) -> bool {
    let room_ok = message
        .get("room")
        .and_then(Value::as_str)
        .is_some_and(|room| room.find('/').is_some_and(|at| at > 0));
    let data_ok = message
        .get("data")
        .is_some_and(|data| data.is_object() && data.to_string().len() <= 16384);
    room_ok && peer_ok(message.get("from")) && peer_ok(message.get("to")) && data_ok
}

fn append(state: &State, changes: &[Value]) -> rusqlite::Result<i64> {
    let mut db = state.db.lock().expect("db");
    let transaction = db.transaction()?;
    {
        let mut insert = transaction.prepare_cached(
            "INSERT INTO changes (collection, key, field, value, clock) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for change in changes {
            insert.execute(params![
                change["collection"].as_str(),
                change["key"].as_str(),
                change["field"].as_str(),
                change
                    .get("value")
                    .cloned()
                    .unwrap_or(Value::Null)
                    .to_string(),
                change["clock"].as_str(),
            ])?;
        }
    }
    transaction.commit()?;
    db.query_row("SELECT COALESCE(MAX(seq), 0) FROM changes", [], |row| {
        row.get(0)
    })
}

fn after(state: &State, since: i64) -> rusqlite::Result<(Vec<Value>, i64)> {
    let db = state.db.lock().expect("db");
    let mut select = db.prepare_cached(
        "SELECT seq, collection, key, field, value, clock FROM changes WHERE seq > ?1 ORDER BY seq LIMIT ?2",
    )?;
    let mut cursor = since;
    let rows = select.query_map(params![since, PAGE], |row| {
        let seq: i64 = row.get(0)?;
        let value: Option<String> = row.get(4)?;
        Ok((
            seq,
            json!({
                "collection": row.get::<_, String>(1)?,
                "key": row.get::<_, String>(2)?,
                "field": row.get::<_, String>(3)?,
                "value": value.and_then(|text| serde_json::from_str::<Value>(&text).ok()).unwrap_or(Value::Null),
                "clock": row.get::<_, String>(5)?,
            }),
        ))
    })?;
    let mut changes = Vec::new();
    for row in rows {
        let (seq, change) = row?;
        cursor = seq;
        changes.push(change);
    }
    Ok((changes, cursor))
}

fn event(name: &str, data: &Value) -> String {
    format!("event: {name}\ndata: {data}\n\n")
}

fn broadcast(state: &State, name: &str, data: &Value, except_peer: Option<&str>) {
    let text = event(name, data);
    let mut listeners = state.listeners.lock().expect("listeners");
    listeners.retain(|listener| {
        except_peer == Some(listener.peer.as_str()) || listener.events.send(text.clone()).is_ok()
    });
}

/// The live stream. Subscribe first, then send the backlog page by page, so nothing pushed in
/// between is missed (a change may come twice; applying one twice changes nothing).
fn live(state: &State, request: Request, url: &str, extra: Vec<Header>) {
    let peer = query(url, "peer").unwrap_or_default().to_owned();
    if peer.len() > 40
        || !peer
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return respond_json(request, extra, 400, json!({ "error": "Bad peer id" }));
    }
    let (events, receiver) = channel();
    let id = {
        let mut next = state.next.lock().expect("next");
        *next += 1;
        *next
    };
    state.listeners.lock().expect("listeners").push(Listener {
        id,
        peer: peer.clone(),
        rooms: HashSet::new(),
        events: events.clone(),
    });
    let _ = events.send("retry: 1000\n\n".into());
    let mut since = query(url, "since")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut first = true;
    while let Ok((changes, cursor)) = after(state, since) {
        let empty = changes.is_empty();
        // One event even when there's nothing (the client learns the cursor), and no empty one
        // after the last full page.
        if empty && !first {
            break;
        }
        first = false;
        let _ = events.send(event(
            "changes",
            &json!({ "changes": changes, "cursor": cursor }),
        ));
        if empty || cursor == since {
            break;
        }
        since = cursor;
    }
    drop(events);
    // The response is written by hand, an event at a time, flushed as it goes: a stream with no
    // length that lasts until the client leaves. A keep-alive comment when it's quiet is also
    // how a client that has gone is noticed (the write fails).
    let mut head = String::from(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\nconnection: close\r\n",
    );
    for each in &extra {
        head.push_str(&format!("{}: {}\r\n", each.field, each.value));
    }
    head.push_str("\r\n");
    let mut writer = request.into_writer();
    let mut send = |text: &[u8]| writer.write_all(text).and_then(|_| writer.flush()).is_ok();
    if send(head.as_bytes()) {
        loop {
            let text = match receiver.recv_timeout(state.keep_alive) {
                Ok(text) => text,
                Err(RecvTimeoutError::Timeout) => ": keep-alive\n\n".to_owned(),
                Err(RecvTimeoutError::Disconnected) => break,
            };
            if !send(text.as_bytes()) {
                break;
            }
        }
    }
    let gone = {
        let mut listeners = state.listeners.lock().expect("listeners");
        let at = listeners.iter().position(|listener| listener.id == id);
        at.map(|at| listeners.remove(at))
    };
    if let Some(listener) = gone {
        for room in listener.rooms {
            broadcast(
                state,
                "presence",
                &json!({ "room": room, "peer": peer, "state": null }),
                Some(&peer),
            );
        }
    }
}
