/**
 * The read-only console.
 *
 * It is one self-contained HTML document: no bundler, no CDN, no build step, no
 * external asset that can go stale or leak a request off the machine. That
 * matters more than elegance here — the console exists so that "see what the
 * team is doing" does not require a terminal, and a page that needs a build
 * pipeline to be observed would be a worse answer than `team status`.
 *
 * It only ever issues GETs. Sending a message, approving a tool call or waking a
 * member all stay in the CLI/API, because a page anyone can open in a browser
 * tab should not be able to make an agent run a command.
 *
 * Live-ness is polling with the same cursor the CLI uses (`?after=<seq>`), not
 * a websocket: a turn can take minutes, browsers drop idle sockets, and the
 * `serve` process may be restarted under the tab.
 */

export interface ConsoleOptions {
  teamName: string;
  /** the API wants a bearer token, so the page has to ask for one */
  requiresToken: boolean;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function renderConsoleHtml(opts: ConsoleOptions): string {
  const title = escapeHtml(opts.teamName);
  const tokenFlag = opts.requiresToken ? "true" : "false";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — agentmesh</title>
<style>
  :root {
    --bg: #0d1117; --panel: #12181f; --panel2: #161d26; --line: #232c38;
    --text: #e6edf3; --dim: #8b98a5; --faint: #5d6b7a;
    --accent: #58a6ff; --ok: #3fb950; --warn: #d29922; --bad: #f85149; --pulse: #a371f7;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fa; --panel: #ffffff; --panel2: #f0f3f6; --line: #d8dee4;
      --text: #1f2328; --dim: #59636e; --faint: #818b98;
      --accent: #0969da; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --pulse: #8250df;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    display: grid; grid-template-rows: auto 1fr; overflow: hidden;
  }
  a { color: var(--accent); }
  code, .mono { font-family: var(--mono); font-size: 12px; }

  header.top {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
  }
  .brand { font-family: var(--mono); font-size: 12px; color: var(--faint); letter-spacing: .04em; }
  header.top h1 { font-size: 14px; font-weight: 600; margin: 0; }
  .counts { color: var(--dim); font-size: 12px; }
  .spacer { flex: 1; }
  .pill {
    font-size: 11px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--dim); white-space: nowrap;
  }
  .pill.live { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .pill.down { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, var(--line)); }
  .readonly { font-size: 11px; color: var(--faint); }

  #tokenbar { display: none; gap: 6px; align-items: center; }
  #tokenbar.on { display: flex; }
  #tokenbar input {
    background: var(--bg); color: var(--text); border: 1px solid var(--line);
    border-radius: 6px; padding: 3px 8px; font-family: var(--mono); font-size: 12px; width: 200px;
  }
  button {
    background: var(--panel2); color: var(--text); border: 1px solid var(--line);
    border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer;
  }
  button:hover { border-color: var(--faint); }

  main {
    display: grid; grid-template-columns: 260px minmax(0, 1fr);
    min-height: 0;
  }
  main.drawer-open { grid-template-columns: 260px minmax(0, 1fr) minmax(320px, 440px); }
  @media (max-width: 980px) {
    main, main.drawer-open { grid-template-columns: 220px minmax(0, 1fr); }
    main.drawer-open aside.drawer {
      position: fixed; inset: 0 0 0 auto; width: min(440px, 92vw); z-index: 20;
      box-shadow: -20px 0 40px rgba(0, 0, 0, .35);
    }
  }

  aside.side {
    border-right: 1px solid var(--line); background: var(--panel);
    overflow-y: auto; padding: 12px 0; min-height: 0;
  }
  aside.side section { margin-bottom: 18px; }
  aside.side h2 {
    font-size: 10px; text-transform: uppercase; letter-spacing: .09em;
    color: var(--faint); margin: 0 0 6px; padding: 0 14px; font-weight: 600;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li.row {
    display: flex; gap: 8px; align-items: baseline; padding: 6px 14px;
    cursor: pointer; border-left: 2px solid transparent;
  }
  li.row:hover { background: var(--panel2); }
  li.row.sel { background: var(--panel2); border-left-color: var(--accent); }
  li.row .grow { flex: 1; min-width: 0; }
  li.row .name { font-weight: 600; }
  li.row .sub { color: var(--dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; margin-top: 5px; }
  .dot.running { background: var(--ok); animation: breathe 1.6s ease-in-out infinite; }
  .dot.queued { background: var(--warn); }
  .dot.waiting { background: var(--bad); }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  .tag {
    font-size: 10px; font-family: var(--mono); color: var(--dim);
    border: 1px solid var(--line); border-radius: 4px; padding: 0 4px;
  }
  .tag.pulse { color: var(--pulse); border-color: color-mix(in srgb, var(--pulse) 40%, var(--line)); }
  .empty { color: var(--faint); font-size: 12px; padding: 2px 14px; }

  section.room { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .room-head {
    display: flex; align-items: baseline; gap: 10px;
    padding: 10px 20px; border-bottom: 1px solid var(--line);
  }
  .room-head h2 { font-size: 13px; margin: 0; font-family: var(--mono); }
  .room-head .meta { color: var(--dim); font-size: 12px; }
  ol.messages { overflow-y: auto; padding: 12px 20px 40px; margin: 0; list-style: none; flex: 1; min-height: 0; }
  li.msg { margin-bottom: 14px; max-width: 760px; }
  li.msg .head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 2px; }
  li.msg .who { font-weight: 600; font-size: 13px; }
  li.msg .who.user { color: var(--accent); }
  li.msg .when { color: var(--faint); font-size: 11px; font-family: var(--mono); }
  li.msg .body { white-space: pre-wrap; overflow-wrap: anywhere; }
  li.msg .body .at { color: var(--accent); }
  li.msg.system { color: var(--dim); font-size: 12px; font-style: italic; padding-left: 2px; }
  li.msg.system .body { white-space: pre-wrap; }

  aside.drawer {
    border-left: 1px solid var(--line); background: var(--panel);
    display: flex; flex-direction: column; min-height: 0;
  }
  /* the hidden attribute loses to a class rule that sets display, so say it */
  aside.drawer[hidden] { display: none; }
  aside.drawer header {
    padding: 10px 16px; border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 8px;
  }
  aside.drawer header h2 { font-size: 13px; margin: 0; }
  aside.drawer header .sub { color: var(--dim); font-size: 11px; }
  .turns { overflow-y: auto; padding: 10px 16px 40px; }
  .turn { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; background: var(--panel2); }
  .turn .th { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-bottom: 6px; }
  .turn .st { font-size: 10px; font-family: var(--mono); padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line); }
  .turn .st.succeeded { color: var(--ok); }
  .turn .st.running { color: var(--accent); }
  .turn .st.queued { color: var(--warn); }
  .turn .st.waiting { color: var(--bad); }
  .turn .st.failed, .turn .st.interrupted, .turn .st.cancelled { color: var(--bad); }
  .turn .meta { color: var(--faint); font-size: 11px; font-family: var(--mono); }
  .turn .ev { display: grid; grid-template-columns: 84px 1fr; gap: 8px; font-size: 12px; padding: 1px 0; }
  .ev .k { color: var(--pulse); font-family: var(--mono); font-size: 10px; text-align: right; }
  .ev .t { color: var(--dim); overflow-wrap: anywhere; }
  .turn .err { color: var(--bad); font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
<header class="top">
  <span class="brand">agentmesh</span>
  <h1 id="teamName">${title}</h1>
  <span class="counts" id="counts"></span>
  <span class="spacer"></span>
  <span class="readonly">read-only</span>
  <span class="pill" id="conn">connecting</span>
  <div id="tokenbar">
    <input id="token" type="password" placeholder="bearer token" autocomplete="off">
    <button id="tokenSave">set</button>
  </div>
</header>
<main id="main">
  <aside class="side">
    <section>
      <h2>Members</h2>
      <ul id="members"><li class="empty">…</li></ul>
    </section>
    <section>
      <h2>Rooms</h2>
      <ul id="channels"><li class="empty">…</li></ul>
    </section>
    <section>
      <h2>Waiting on a human</h2>
      <ul id="approvals"><li class="empty">nothing blocked</li></ul>
    </section>
  </aside>

  <section class="room">
    <div class="room-head">
      <h2 id="roomTitle">general</h2>
      <span class="meta" id="roomMeta"></span>
    </div>
    <ol class="messages" id="messages"></ol>
  </section>

  <aside class="drawer" id="drawer" hidden>
    <header>
      <h2 id="drawerName"></h2>
      <span class="sub" id="drawerSub"></span>
      <span class="spacer"></span>
      <button id="drawerClose">close</button>
    </header>
    <div class="turns" id="turns"></div>
  </aside>
</main>
<script>
(function () {
  "use strict";
  var WANTS_TOKEN = ${tokenFlag};
  var TOKEN_KEY = "agentmesh.team.token";
  var POLL_MS = 2000;

  var state = {
    token: "",
    channel: null,
    cursor: 0,
    member: null,
    deepLinked: false,
    uiKey: null,
    seen: {},
    status: null
  };
  try { state.token = sessionStorage.getItem(TOKEN_KEY) || ""; } catch (e) { state.token = ""; }

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function rich(s) {
    // Highlight @handles without ever letting raw text become markup.
    return esc(s).replace(/(^|[^A-Za-z0-9_@])@([A-Za-z0-9_-]{1,32})/g, '$1<span class="at">@$2</span>');
  }
  function hhmm(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function dur(ms) {
    if (!ms) return "";
    if (ms < 1000) return ms + "ms";
    if (ms < 60000) return Math.round(ms / 1000) + "s";
    if (ms < 3600000) return Math.round(ms / 60000) + "m";
    return Math.round(ms / 3600000) + "h";
  }
  function api(path) {
    var headers = {};
    if (state.token) headers.authorization = "Bearer " + state.token;
    return fetch(path, { headers: headers }).then(function (r) {
      if (r.status === 401) {
        showToken(true);
        throw new Error("unauthorized");
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function showToken(show) { $("tokenbar").className = show || (WANTS_TOKEN && !state.token) ? "on" : ""; }
  $("tokenSave").addEventListener("click", function () {
    var v = $("token").value.trim();
    if (!v) return;
    state.token = v;
    try { sessionStorage.setItem(TOKEN_KEY, v); } catch (e) {}
    $("token").value = "";
    showToken(false);
    poll();
  });

  function setConn(ok, text) {
    var el = $("conn");
    el.className = "pill " + (ok ? "live" : "down");
    el.textContent = text || (ok ? "live" : "reconnecting");
  }

  function renderStatus(s) {
    state.status = s;
    var c = [];
    if (s.running) c.push(s.running + " running");
    if (s.queued) c.push(s.queued + " queued");
    if (s.waiting) c.push(s.waiting + " waiting");
    if (s.unclaimed) c.push(s.unclaimed + " on the board");
    $("counts").textContent = s.members.length + " members" + (c.length ? " · " + c.join(" · ") : " · quiet");

    // Polling twice a second and rebuilding the sidebar every time would eat
    // hovers and scroll position while nothing changed. Rebuild only on change.
    var key = JSON.stringify([
      state.channel, state.member, s.running, s.queued, s.waiting, s.unclaimed,
      s.members.map(function (m) { return [m.id, m.name, m.role, m.status, m.queued, m.pulseEveryMs, m.claims]; }),
      s.channels.map(function (x) { return [x.id, x.title, x.kind, x.messageCount, x.lastMessageAt, x.description, x.members]; }),
      s.approvals
    ]);
    if (key === state.uiKey) return;
    state.uiKey = key;

    var ml = $("members");
    ml.innerHTML = "";
    s.members.forEach(function (m) {
      var li = document.createElement("li");
      li.className = "row" + (state.member === m.id ? " sel" : "");
      var bits = [m.role || ("@" + m.mention)];
      if (m.queued) bits.push(m.queued + " queued");
      if (m.status !== "idle") bits.push(m.status);
      li.innerHTML =
        '<span class="dot ' + esc(m.status) + '"></span>' +
        '<span class="grow"><span class="name">' + esc(m.name) + "</span>" +
        (m.pulseEveryMs ? ' <span class="tag pulse">pulse ' + esc(dur(m.pulseEveryMs)) + "</span>" : "") +
        (m.claims && m.claims.length ? ' <span class="tag">claims</span>' : "") +
        '<div class="sub">' + esc(bits.join(" · ")) + "</div></span>" +
        (m.status === "waiting" ? '<span class="tag">blocked</span>' : "");
      li.addEventListener("click", function () { openMember(m.id); });
      ml.appendChild(li);
    });
    if (!s.members.length) ml.innerHTML = '<li class="empty">no members</li>';

    var cl = $("channels");
    cl.innerHTML = "";
    s.channels.forEach(function (ch) {
      var li = document.createElement("li");
      li.className = "row" + (state.channel === ch.id ? " sel" : "");
      li.innerHTML =
        '<span class="grow"><span class="name">' + esc(ch.kind === "dm" ? ch.title : "# " + ch.title) + "</span>" +
        '<div class="sub">' + esc(ch.messageCount + " messages" + (ch.lastMessageAt ? " · " + hhmm(ch.lastMessageAt) : "")) + "</div></span>";
      li.addEventListener("click", function () { selectChannel(ch.id); });
      cl.appendChild(li);
    });
    if (!s.channels.length) cl.innerHTML = '<li class="empty">no rooms yet</li>';

    var al = $("approvals");
    al.innerHTML = "";
    if (!s.approvals || !s.approvals.length) {
      al.innerHTML = '<li class="empty">nothing blocked</li>';
    } else {
      s.approvals.forEach(function (a) {
        var li = document.createElement("li");
        li.className = "row";
        li.innerHTML =
          '<span class="grow"><span class="name">' + esc(a.memberId) + "</span>" +
          '<div class="sub">' + esc(a.kind) + " · " + esc(a.approvalId) + "</div></span>" +
          '<span class="tag">approve</span>';
        li.addEventListener("click", function () { openMember(a.memberId); });
        al.appendChild(li);
      });
      var note = document.createElement("li");
      note.className = "empty";
      note.textContent = "resolve from the CLI: agentmesh team approve --help";
      al.appendChild(note);
    }
  }

  function selectChannel(id) {
    if (state.channel === id) return;
    state.channel = id;
    state.cursor = 0;
    state.seen = {};
    $("messages").innerHTML = "";
    var ch = (state.status && state.status.channels || []).filter(function (c) { return c.id === id; })[0];
    if (ch) renderRoomHead(ch);
    poll();
  }

  function renderRoomHead(ch) {
    $("roomTitle").textContent = ch.kind === "dm" ? ch.title : "# " + ch.title;
    var bits = [];
    if (ch.description) bits.push(ch.description);
    if (ch.members && ch.members.length) bits.push("with " + ch.members.join(", "));
    $("roomMeta").textContent = bits.join(" — ");
  }

  function nearBottom() {
    var ol = $("messages");
    return ol.scrollHeight - ol.scrollTop - ol.clientHeight < 80;
  }

  function renderMessage(m) {
    var li = document.createElement("li");
    li.className = "msg" + (m.kind === "system" ? " system" : "");
    var when = '<span class="when">' + hhmm(m.createdAt) + "</span>";
    if (m.kind === "system") {
      li.innerHTML = '<div class="body">' + rich(m.text) + "</div>";
    } else {
      var who = m.author === "user" ? "user" : (m.authorName || m.author);
      li.innerHTML =
        '<div class="head"><span class="who' + (m.author === "user" ? " user" : "") + '">' + esc(who) + "</span>" +
        when + (m.hops > 0 ? ' <span class="tag">hop ' + m.hops + "</span>" : "") + "</div>" +
        '<div class="body">' + rich(m.text) + "</div>";
    }
    return li;
  }

  function appendMessages(list) {
    if (!list || !list.length) return;
    var stick = nearBottom();
    var ol = $("messages");
    list.forEach(function (m) {
      if (state.seen[m.id]) return;
      state.seen[m.id] = true;
      ol.appendChild(renderMessage(m));
      if (m.seq > state.cursor) state.cursor = m.seq;
    });
    while (ol.children.length > 400) ol.removeChild(ol.firstChild);
    if (stick) ol.scrollTop = ol.scrollHeight;
  }

  function openMember(id) {
    state.member = id;
    $("drawer").hidden = false;
    $("main").className = "drawer-open";
    var m = (state.status && state.status.members || []).filter(function (x) { return x.id === id; })[0];
    $("drawerName").textContent = m ? m.name : id;
    $("drawerSub").textContent = m ? (m.role || "@" + m.mention) + " · " + m.status : "";
    $("turns").innerHTML = '<div class="empty">loading…</div>';
    if (state.status) renderStatus(state.status);
    refreshTranscript();
  }
  function closeMember() {
    state.member = null;
    $("drawer").hidden = true;
    $("main").className = "";
    if (state.status) renderStatus(state.status);
  }
  $("drawerClose").addEventListener("click", closeMember);

  function eventLabel(e) {
    var d = e.data || {};
    var kind = d.kind ? String(d.kind) : e.type;
    var n = Number(d.chunks || 1);
    return n > 1 ? kind + "×" + n : kind;
  }

  function renderTurns(turns) {
    var box = $("turns");
    if (!turns.length) {
      box.innerHTML = '<div class="empty">this member has not run yet</div>';
      return;
    }
    box.innerHTML = "";
    turns.slice().reverse().forEach(function (t) {
      var div = document.createElement("div");
      div.className = "turn";
      var meta = hhmm(t.startedAt || t.queuedAt) + " → " + (t.endedAt ? hhmm(t.endedAt) : "…") +
        " · hops " + t.hops + " · " + t.channel;
      var html =
        '<div class="th"><span class="st ' + esc(t.status) + '">' + esc(t.status) + "</span>" +
        (t.kind === "pulse" ? '<span class="tag pulse">pulse</span>' : "") +
        '<span class="meta">' + esc(meta) + "</span></div>";
      (t.events || []).forEach(function (e) {
        var text = String(e.text || "").replace(/\\s+/g, " ").trim();
        if (text.length > 600) text = text.slice(0, 599) + "…";
        html += '<div class="ev"><span class="k">' + esc(eventLabel(e)) + '</span><span class="t">' + esc(text) + "</span></div>";
      });
      if (t.error) html += '<div class="err">' + esc(t.error) + "</div>";
      div.innerHTML = html;
      box.appendChild(div);
    });
  }

  function refreshTranscript() {
    if (!state.member) return Promise.resolve();
    var id = state.member;
    return api("/team/members/" + encodeURIComponent(id) + "/transcript?limit=12").then(function (d) {
      if (state.member === id) renderTurns(d.turns || []);
    });
  }

  function pickChannel(channels) {
    var rooms = channels.filter(function (c) { return c.kind !== "dm"; });
    if (rooms.length) {
      var general = rooms.filter(function (c) { return c.id === "general"; })[0];
      return (general || rooms[0]).id;
    }
    return channels.length ? channels[0].id : "general";
  }

  var inflight = false;
  function poll() {
    if (document.hidden || inflight) return;
    inflight = true;
    api("/team").then(function (s) {
      setConn(true);
      renderStatus(s);
      // ?member=qa opens that member's drawer, so "look at what Lin is doing"
      // is a link you can paste, not a sequence of clicks.
      if (!state.deepLinked) {
        state.deepLinked = true;
        var want = new URLSearchParams(location.search).get("member");
        if (want) openMember(want);
      }
      var next = state.channel || pickChannel(s.channels || []);
      if (next !== state.channel) {
        state.channel = next;
        state.cursor = 0;
        state.seen = {};
      }
      var ch = (s.channels || []).filter(function (c) { return c.id === state.channel; })[0];
      if (ch) renderRoomHead(ch);
      return api("/team/messages?channel=" + encodeURIComponent(state.channel) + "&after=" + state.cursor + "&limit=200")
        .then(function (d) { appendMessages(d.messages); })
        .then(refreshTranscript);
    }).catch(function () {
      setConn(false);
    }).then(function () {
      inflight = false;
    });
  }

  document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
  poll();
  setInterval(poll, POLL_MS);
})();
</script>
</body>
</html>
`;
}
