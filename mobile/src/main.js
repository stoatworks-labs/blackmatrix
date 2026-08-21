// The shell. Its whole job is choosing a server and then getting out of the way.

const invoke = window.__TAURI__?.core?.invoke;
const RECENT_KEY = 'blackmatrix.mobile.recent';

const el = (id) => document.getElementById(id);
const picker = el('picker');
const hostView = el('host-view');
const frame = el('frame');
const status = el('status');

function recents() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function remember(address, port) {
  const entry = `${address}:${port}`;
  const list = [entry, ...recents().filter((item) => item !== entry)].slice(0, 5);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* a full or private store just means no history */
  }
  drawRecents();
}

function drawRecents() {
  const list = recents();
  el('recent-wrap').hidden = list.length === 0;
  el('recent').replaceChildren(
    ...list.map((entry) => {
      const [address, port] = entry.split(':');
      return row(address, Number(port), 'last used');
    }),
  );
}

function row(address, port, meta) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  const addr = document.createElement('span');
  addr.className = 'addr';
  addr.textContent = `${address}:${port}`;
  const note = document.createElement('span');
  note.className = 'meta';
  note.textContent = meta;
  button.append(addr, note);
  button.addEventListener('click', () => connect(address, port));
  li.append(button);
  return li;
}

function connect(address, port) {
  remember(address, port);
  el('hostlabel').textContent = `${address}:${port}`;
  frame.src = `http://${address}:${port}/`;
  picker.hidden = true;
  hostView.hidden = false;
}

function disconnect() {
  // Blanked rather than left loaded: a control surface in the background is a
  // control surface someone can still tap by accident.
  frame.src = 'about:blank';
  hostView.hidden = true;
  picker.hidden = false;
}

el('back').addEventListener('click', disconnect);
el('reload').addEventListener('click', () => {
  frame.src = frame.src;
});

el('manual').addEventListener('submit', (event) => {
  event.preventDefault();
  const address = el('host').value.trim();
  const port = Number(el('port').value) || 8533;
  if (address) connect(address, port);
});

el('scan').addEventListener('click', async () => {
  if (!invoke) {
    status.textContent = 'Scanning needs the app — type an address instead.';
    return;
  }
  const button = el('scan');
  button.disabled = true;
  status.textContent = 'Looking on the local network…';
  el('found').replaceChildren();
  try {
    const port = Number(el('port').value) || 8533;
    const servers = await invoke('discover', { port });
    if (servers.length === 0) {
      status.textContent = 'Nothing answered. Check the server is running, and that this phone is on the same network.';
    } else {
      status.textContent = `${servers.length} server${servers.length === 1 ? '' : 's'} found.`;
      el('found').replaceChildren(
        ...servers.map((server) =>
          row(
            server.address,
            server.port,
            `${server.name} · ${server.devices} device${server.devices === 1 ? '' : 's'}`,
          ),
        ),
      );
    }
  } catch (error) {
    status.textContent = String(error);
  } finally {
    button.disabled = false;
  }
});

drawRecents();
