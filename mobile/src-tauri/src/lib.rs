//! BlackMatrix on a phone: find a server, then show it.
//!
//! The app is deliberately thin. It does not speak the ATEM or Videohub
//! protocols — a phone has no business holding a switcher connection open while
//! the OS suspends it, and the panel emulation needs a listening socket anyway.
//! What it adds over a browser bookmark is the one thing a web page cannot do:
//! **find the server without anyone typing an address.**

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::sync::mpsc;
use std::time::Duration;

/// A BlackMatrix server that answered.
#[derive(Serialize, Clone, Debug)]
pub struct Found {
    /// The address it answered on. A machine with several interfaces answers on
    /// each of them, which is why `id` exists.
    pub address: String,
    pub port: u16,
    /// Stable per server, from its health payload. Used to collapse duplicates.
    pub id: String,
    /// What a human calls that machine.
    pub name: String,
    pub devices: u64,
}

const DEFAULT_PORT: u16 = 8533;
/// Short: everything here is on the same LAN, and a sweep that takes a minute
/// is a sweep nobody waits for.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
const READ_TIMEOUT: Duration = Duration::from_millis(700);
const WORKERS: usize = 48;

/// The /24s this device is on. A phone usually has exactly one.
fn local_subnets() -> Vec<[u8; 3]> {
    let mut subnets: Vec<[u8; 3]> = Vec::new();
    let Ok(addrs) = if_addrs::get_if_addrs() else {
        return subnets;
    };
    for iface in addrs {
        if iface.is_loopback() {
            continue;
        }
        if let IpAddr::V4(v4) = iface.ip() {
            let octets = v4.octets();
            let prefix = [octets[0], octets[1], octets[2]];
            if !subnets.contains(&prefix) {
                subnets.push(prefix);
            }
        }
    }
    subnets
}

/// Ask one host whether it is a BlackMatrix server.
///
/// A hand-written GET rather than an HTTP client: the whole exchange is one
/// request whose answer is a short JSON object, and this keeps the app free of
/// a TLS stack it has no use for.
fn probe(addr: SocketAddr) -> Option<Found> {
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(READ_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(READ_TIMEOUT)).ok()?;

    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: application/json\r\n\r\n",
        addr
    );
    stream.write_all(request.as_bytes()).ok()?;

    let mut body = String::new();
    let mut buf = [0u8; 1024];
    // Bounded: a health response is tiny, and anything long is not one.
    while body.len() < 4096 {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => body.push_str(&String::from_utf8_lossy(&buf[..n])),
            Err(_) => break,
        }
    }

    // Something else may well be listening on this port; only a BlackMatrix
    // health payload counts.
    if !body.contains("\"ok\":true") {
        return None;
    }
    let devices = field_number(&body, "devices").unwrap_or(0);
    let id = field_string(&body, "id").unwrap_or_else(|| addr.to_string());
    let name = field_string(&body, "name").unwrap_or_else(|| addr.ip().to_string());

    Some(Found {
        address: addr.ip().to_string(),
        port: addr.port(),
        id,
        name,
        devices,
    })
}

/// Pull one string field out of the health payload. Deliberately small: the
/// payload is a flat object of known shape, and a JSON parser here would be
/// weight for nothing.
fn field_string(body: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\":\"", key);
    let rest = body.split(&needle).nth(1)?;
    Some(rest.chars().take_while(|c| *c != '"').collect())
}

fn field_number(body: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{}\":", key);
    let rest = body.split(&needle).nth(1)?;
    let digits: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// Sweep the local networks for BlackMatrix servers.
#[tauri::command]
async fn discover(port: Option<u16>) -> Result<Vec<Found>, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let subnets = local_subnets();
    if subnets.is_empty() {
        return Err("this device is not on an IPv4 network".into());
    }

    let mut targets: Vec<SocketAddr> = Vec::new();
    for prefix in subnets {
        for host in 1u8..=254 {
            let ip = IpAddr::from([prefix[0], prefix[1], prefix[2], host]);
            targets.push(SocketAddr::new(ip, port));
        }
    }

    let (send_work, work) = mpsc::channel::<SocketAddr>();
    let work = std::sync::Arc::new(std::sync::Mutex::new(work));
    let (send_found, found) = mpsc::channel::<Found>();

    let mut handles = Vec::new();
    for _ in 0..WORKERS.min(targets.len()) {
        let work = std::sync::Arc::clone(&work);
        let send_found = send_found.clone();
        handles.push(std::thread::spawn(move || loop {
            let next = {
                let guard = work.lock().unwrap();
                guard.recv()
            };
            match next {
                Ok(addr) => {
                    if let Some(hit) = probe(addr) {
                        let _ = send_found.send(hit);
                    }
                }
                Err(_) => break,
            }
        }));
    }
    drop(send_found);

    for addr in targets {
        let _ = send_work.send(addr);
    }
    drop(send_work);

    for handle in handles {
        let _ = handle.join();
    }

    // One server answering on six interfaces is one server. Keep the first
    // address per id, preferring a private LAN address over anything else —
    // a VPN or bridge address may well be unreachable from where the phone is.
    let mut results: Vec<Found> = Vec::new();
    for hit in found.into_iter() {
        match results.iter_mut().find(|existing| existing.id == hit.id) {
            Some(existing) => {
                if !is_lan(&existing.address) && is_lan(&hit.address) {
                    existing.address = hit.address;
                }
            }
            None => results.push(hit),
        }
    }
    results.sort_by(|a, b| a.name.cmp(&b.name).then(a.address.cmp(&b.address)));
    Ok(results)
}

/// The ordinary private ranges. A tailnet or a bridge address is reachable from
/// this machine and often not from anywhere else.
fn is_lan(address: &str) -> bool {
    let octets: Vec<u8> = address
        .split('.')
        .filter_map(|part| part.parse::<u8>().ok())
        .collect();
    match octets.as_slice() {
        [192, 168, _, _] => true,
        [10, _, _, _] => true,
        [172, second, _, _] if (16..=31).contains(second) => true,
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![discover])
        .run(tauri::generate_context!())
        .expect("error while running BlackMatrix");
}
