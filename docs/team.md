# Teams: named members in shared rooms

A **team** is a layer above workers. A worker is an execution slot; a member is a
colleague with a name, a job, a workspace, a conversation that persists, and a
memory file. Members talk in rooms, and an `@mention` is what hands the next turn
to a teammate.

This is not "a master splitting a task into subtasks". Nothing in the team layer
decides who does what: the user addresses someone, and the members address each
other. The routing engine only delivers messages and bounds the conversation.

```
         you
          │  post / DM
          ▼
   ┌─────────────── team process ───────────────┐
   │  channels + DMs (SQLite)   inbox per member │
   │        │                        │           │
   │        └──── @mention ──────────┘           │
   │                 │                           │
   │      ┌──────────┼──────────┐                │
   │      ▼          ▼          ▼                │
   │    Mira       Sam        Lin                │
   │  (ceo)     (engineer)  (verifier)           │
   │  session    session     session             │
   │  + MEMORY   + MEMORY    + MEMORY            │
   └─────────────────────────────────────────────┘
```

Each member is a pinned agentmesh worker: `sessionKey = team:<name>:<member id>`.
That single detail is what makes the person persistent — the same agent session,
with its history, is resumed on the next turn and after a process restart.

A member is *just a profile*, and a profile is just a driver, so one roster can mix
harnesses: a CEO on pi, an engineer on opencode, a verifier on a third box through
`driver: remote`. The room does not know or care which CLI answered; it sees members.

## Quick start

```yaml
# agentmesh.yaml
workdir: .agentmesh

profiles:
  - name: claude-code
    driver: acpx
    agent: claude              # acpx built-in, or any custom `command`
  - name: pi
    driver: acpx
    agent: pi

team:
  name: acme
  port: 4317
  tokenEnv: AGENTMESH_TEAM_TOKEN   # the VALUE stays in the environment
  members:
    - id: ceo
      name: Mira
      role: splits goals, assigns work, reports to the user
      profile: claude-code
      notes: Keep updates short. Ship on Fridays only.
    - id: dev
      name: Sam
      role: engineer, writes and fixes code
      profile: pi
    - id: qa
      name: Lin
      role: verifier, tests what was built
      profile: pi
  channels:
    - id: general
      description: the whole team
    - id: ops
      members: [ceo, qa]        # dev is not addressable here
```

```bash
agentmesh team serve --config agentmesh.yaml   # keep this running
agentmesh team chat                            # talk to the room
```

`team serve` is the long-running part: it owns the agent sessions. The CLI is a
client of its JSON API, so closing the terminal does not kill the team.

## The roster

| key | meaning |
|---|---|
| `id` | stable identity; also the `@handle` unless `mention` overrides it |
| `name` | display name shown to teammates |
| `role` | one line injected into every teammate's prompt |
| `profile` | which harness runs this member (`claude`, `pi`, `opencode`, …) |
| `mention` | handle without `@`; defaults to `id`; ids and handles must be unique |
| `cwd` | workspace; relative to `team.cwd`, then the mesh base directory |
| `notes` | standing instructions, prepended to every turn |

Two members can use the same profile — they still get separate sessions, because
the session key includes the member id. Two members **cannot** share a handle; the
team refuses to start rather than guessing who `@dev` means.

`profile` is where the mixed stack lives: the CEO can be Claude Code while the
engineer is Pi and the verifier is OpenCode. The team layer only sees "a member".

## Rooms, DMs, and mentions

**Channels** are declared in config. `members` is who can be addressed there;
omitting it means everyone. A mention of someone outside the room is not routed,
and the channel gets a system line saying so (silent non-delivery looks like the
teammate ignored the request).

**DMs** are not declared: `dm:user:<member>` exists because someone spoke in it.
A user message in a DM addresses its partner without an `@` — the window already
has one person in it. Any teammate named in a DM is pulled into the thread and
stays a participant for the rest of it, so an introduction is durable.

**Mentions** are parsed from the message text: `@ceo`, `@dev`, case-insensitive,
Unicode letters allowed (`@研发`). Address-style strings are not mentions
(`a@dev.io` matches nothing). `@user` / `@you` / `@human` asks the human, and never
queues a turn.

A reply is posted to the room **verbatim**. That is the whole protocol: members
write messages, not reports about messages, and the transcript is the state.

## Turns, scheduling, and the two caps

A message with mentions creates one **turn** per mentioned member. A turn is one
agentmesh task on that member's pinned session.

- **One turn at a time per member.** A transcript must not interleave two prompts,
  so a member's inbox is FIFO and the next turn starts only when the previous one
  settles.
- **Members run in parallel.** Different people can work at once; the team honours
  `limits.maxConcurrentTasks` as backpressure (extra turns stay queued in the
  roster, not refused inside the task scheduler). `0` means no team-level cap.
- **Depth cap.** `team.maxHops` (default 6) bounds how far one message may travel.
  A turn at the cap cannot hand off further.
- **Thread cap.** `team.maxTurnsPerMessage` (default 16) bounds total turns caused
  by one root message, so a fan-out cannot become a company-wide storm.

Both caps are counted, and hitting one posts a system message in the room ("not
queued: @dev (hand-off depth 6 reached)") instead of failing silently.

**Mentions fan out; they do not queue.** One message naming two people starts both
at once. That is where the parallelism comes from, and it is also why a verifier
named in the same breath as the builder can run before the artifact exists: there
is no dependency graph behind a room, so *ordering* has to come from the wording —
address one teammate per step when the sequence matters. A live pi + opencode run
made this concrete: the CEO named both, the verifier honestly reported
`ERR_MODULE_NOT_FOUND`, and the chain only converged when the builder's own message
re-raised the mention — six member messages for a three-step job, two of them noise.

Each turn's prompt contains: the member's identity and role, the current room and
its people, the recent transcript, the triggering message, the member's `notes`,
and the contents of its `MEMORY.md`. It also states the reply convention — that
the reply is posted as-is and an `@handle` queues the next turn — which is the
only "team protocol" a member has to learn.

## Memory and continuity

Three things persist, and they are different:

| what | where | survives a restart |
|---|---|---|
| conversation history | the agent's own ACP session, keyed by `sessionKey` | yes, resumed from the harness's session store |
| durable notes | `<stateDir>/members/<id>/MEMORY.md` | yes, a plain file |
| inbox | `turns` table in `<stateDir>/team.sqlite` | queued turns yes; in-flight turns are failed, not replayed |

`MEMORY.md` is read at the start of every turn (capped at 4 KB) and the member is
told its path, so it can append decisions, preferences and context. It is ordinary
text on disk: reviewable, diffable, editable by hand.

A turn that was **running** when the process stopped is marked failed and reported
in its channel. It is not replayed automatically: the agent may already have
edited files, and a silent retry could apply the same change twice. Queued turns
were never started, so they run on the next start.

### Rotating a conversation

The harness session is the one thing that grows without a ceiling: every turn
re-sends the whole conversation, so a member that has been at work since morning
pays for the morning on every turn. `sessionTurns` puts a lifespan on it.

```yaml
team:
  sessionTurns: 40          # everyone, unless a member says otherwise
  members:
    - id: qa
      profile: pi
      sessionTurns: 10      # the verifier's turns are small; rotate it often
```

- **The generation is derived, not stored.** A member's key is
  `team:<name>:<id>` for its first N turns and `team:<name>:<id>#k` after that,
  where `k` is `settled turns ÷ N`. Both halves live in SQLite, so a restart
  resumes the current generation instead of quietly starting over.
- **The old worker is closed.** Rotating the key alone would leave one live agent
  process per generation — the cost the feature exists to remove. The previous
  worker is closed on the next turn (if it is idle; a busy one is retried later).
- **Continuity is the room, not the session.** The next turn still gets the
  member's identity, `notes`, recent transcript and `MEMORY.md`, and the room says
  once per rotation that it happened. Anything the member cared about has to be in
  one of those places — which is also why the prompt tells it to write decisions
  down instead of relying on the conversation.
- **Per turn, on the record.** Each turn stores the key it ran under
  (`team transcript` prints it), so "when did this member start fresh" is a fact in
  the data rather than a guess from the clock.

## Waking up: pulses

A member that only speaks when spoken to is a very responsive tool, not a
colleague. `pulse` lets a member wake on its own schedule and decide whether the
room needs anything — a finished result, a risk, work it can pick up.

```yaml
team:
  members:
    - id: ceo
      name: Mira
      profile: pi
      pulse: { everyMs: 600000, idleOnly: true }   # every 10 minutes
```

A pulse is a normal turn with **no triggering message**: the member sees the room
as it stands plus how long it has been quiet, and is asked whether it has
something worth saying. Three rules keep it from becoming noise:

- **`SILENT` is the expected answer.** Replying `SILENT` posts nothing at all —
  not even a "checked, nothing new" system line. A wake-up that found nothing is
  invisible to the room but still visible in that member's `transcript`.
- **It does not cut in.** With `idleOnly` (the default) a pulse only fires when
  the whole team is quiet, so it never competes with real work for a slot or
  talks over a conversation in progress. Set `idleOnly: false` for a lead that
  should be able to report progress while others work.
- **It starts its own thread.** The message a pulse produces is its own root, so
  its `@mentions` get a fresh hop/turn allowance instead of spending whatever
  conversation happened to be last in the room.

`everyMs` has a 1-second floor and no upper bound; each pulse is a **real, paid
agent turn**, so minutes are the sane range and `limits.maxTotalTokens` /
`maxTotalCost` are the backstop. Pulses are off unless configured — a roster that
does not mention `pulse` behaves exactly as before.

A pulse has the member's normal tool permissions — it is the same agent, woken
by a timer instead of a message — so an unprompted turn **can** edit files. The
guardrails are the profile's `permissionMode`, the spend ceilings, and the fact
that every pulse is visible in that member's transcript afterwards.

Wake one member by hand with `agentmesh team pulse <member>` (same guards: if the
room is busy, it stays asleep and says so). `team status` marks who wakes on their
own, and `team transcript` labels those turns `(pulse)`.

## The board

A message that mentions nobody used to be a dead end: the team said "nobody was
addressed" and the work sat there. It is really work looking for an owner, so a
member can opt into picking it up.

```yaml
team:
  claimTtlMs: 3600000        # how long an unaddressed message stays claimable
  members:
    - id: dev
      name: Sam
      profile: pi
      claims: [general]      # pick up messages nobody was named in
```

Post to `#general` without a handle and the message goes on the room's **board**.
The first free claimant is offered it: a normal turn whose trigger is that
message, told plainly that nobody named it and that the work is held for it while
it decides. Three outcomes, three meanings:

- **It does the work.** The reply is posted like any other message and the item
  leaves the board.
- **It replies `SILENT`.** Nothing is posted, and the item goes to the next
  claimant — passing is a fact about that member, not a verdict on the work.
- **The turn fails.** Same as silence: the work returns to the room.

Rules that keep this from becoming an inbox nobody reads:

- **Only the user's unaddressed messages go on the board.** Members report and
  chat without mentioning anybody all the time; that is conversation, not work.
- **One owner at a time, decided in SQLite.** Claiming is one `BEGIN IMMEDIATE`
  transaction, so two members waking at the same moment cannot both take the same
  item; everybody else simply looks at the next one.
- **Whoever has been quiet longest is asked first**, so the same helpful
  colleague does not end up with every job.
- **An item expires.** `claimTtlMs` (default one hour, `0` = never) marks where
  work stops being work and becomes history — last week's remark is a decision
  for the user, not a nudge for the team.
- **It does not wait for a quiet room.** A pulse waits for silence; a claim does
  the opposite, because the whole point is that this member is free while others
  are not.

`agentmesh team board [channel]` lists what is open and who has what; the same
data is at `GET /team/board`. Claim turns are labelled `(claimed)` in
`team transcript`, so "why did Sam answer a message that was not for him" is one
command away. A message taken straight off the board is also the trigger of a
turn the caller can follow — `team say --wait` waits for the claimant, not for
silence.

**A one-person room never uses the board.** With nobody else to name, a user
message there is addressed to that member implicitly, so the claim path only
starts once a room has two or more members.

**Asking for silence is not the same as getting it.** The prompt gives the member
a way out (`SILENT`), but a helpful model would rather route the work than drop
it. In a real pi run, the message *"Reminder to myself: I still need to decide
the enterprise pricing before Thursday"* was claimed, handed to the CEO, answered
again by the engineer after the CEO said "no action needed from @dev", and cost
three turns before the room went quiet — one remark, three bills. Saying in the
claim prompt that a note the user wrote to themselves is nobody's task brought
the same message down to one turn and zero messages, with the item still open on
the board. `claims` is a routing hint, not a filter: if a room must stay quiet,
address the person you mean.

## Watching the work

The group chat is not a summary written by the CEO. Every member's turns are
stored with the task events behind them.

```bash
agentmesh team status                     # who is idle / running / waiting
agentmesh team log general --limit 20     # the room, including system notices
agentmesh team transcript dev --limit 5   # what dev actually did, turn by turn
agentmesh team dm qa "risk check?" --wait # private thread; wait for the answer
agentmesh team approve <approvalId> allow_once            # permission request
agentmesh team respond <approvalId> accept --content '{}' # elicitation question
```

`transcript` shows the agent's tool calls and status events per turn, not just its
final text — the same events the task API exposes, scoped to one member. A
streaming harness reports one event per token; the transcript folds consecutive
deltas of the same stream into one readable line, labelled with the stream and its
delta count (`text×20` for the answer, `thought×33` for the reasoning), while tool
calls stay one per line because each is a distinct action.

`approve` and `respond` are separate on purpose: a permission request is a
decision (`allow_once`, `reject_always`, …), while an elicitation is an answer
(`accept` / `decline` / `cancel` plus a content payload). Same broker underneath,
different question.

| endpoint | purpose |
|---|---|
| `GET /team` | status, members, channels, pending approvals |
| `GET /team/channels` | rooms and DMs that exist |
| `GET /team/messages?channel=&after=&limit=` | paged transcript (use `after` as a cursor) |
| `POST /team/messages` | `{channel, text}` or `{to, text}` for a DM; returns the turns it created |
| `GET /team/turns/<id>` | one turn's state — what a waiting CLI follows |
| `GET /team/members/<id>/transcript?limit=` | turns + task events |
| `GET /team/approvals` · `POST /team/approvals` | list and resolve blockers (`decision` for permission, `action`+`content` for elicitation) |

The API is JSON and deliberately boring: poll with a cursor. A team turn can take
minutes, and a cursor survives restarts, reconnects, and a CLI that was closed.

## The console

`team serve` also serves a read-only console at the same address:

```text
http://127.0.0.1:4317/
```

Roster on the left (who is running, queued, blocked, who wakes on its own), the
room in the middle, and one member's transcript in a drawer. `/?member=qa` opens
that drawer directly, so "look at what Lin is doing" is a link you can paste
rather than a sequence of clicks.

It is a single self-contained HTML document — no external assets, no CDN, no build
step — and it only ever issues GETs. Sending a message, approving a tool call and
waking a member all stay in the CLI or the API, because a page anyone can open in a
browser tab should not be able to make an agent run a command.

The shell is unauthenticated even when the API requires a token (a browser cannot
set `Authorization` on a navigation); the page asks for the token, keeps it in
`sessionStorage`, and every number on screen comes from an authenticated call it
makes itself. Live-ness is the same `?after=` cursor the CLI uses, polled every two
seconds, so a restarted `serve` just picks up where it left off.

## Security

The team API can make agents run tools on this machine, so it is equivalent to
local shell access:

- binds `127.0.0.1` by default;
- a non-loopback bind **requires** a bearer token (`team.tokenEnv`, value from the
  environment only);
- put TLS in front of it (reverse proxy) if it leaves the machine — the built-in
  server does not terminate TLS;
- each member's tool permissions still come from its harness profile
  (`permissionMode`, harness-side settings), not from the team layer.

## Limits of this layer

Honest boundaries, so nobody expects more than is there:

- **The console is read-only.** `team chat`, `team log`, the HTTP API and the page at
  `/` are the interface. The page shows the room and the turns behind each message;
  it cannot post, approve, or wake anyone — that stays in the CLI.
- **Proactivity has to be switched on.** By default a member still only speaks when
  addressed or mentioned. `pulse` lets one wake on a timer, and `claims` lets it
  pick up messages nobody was named in — but both are configuration, and every
  turn either one causes is a real billed turn.
- **A shared checkout, by default.** Members default to the same `cwd`, so they see
  each other's files. For isolated trees, create one stable worktree directory per
  member and set it as `cwd` — do **not** use `worktree: true`, which is refused
  with a pinned session (a new path every spawn would silently start a new
  conversation).
- **One team per process.** Two teams need two `serve` processes with distinct
  `stateDir` and port.
- **Cost is real.** Each turn is a full agent turn on a real harness; parallel
  members multiply spend. Use `limits.maxTotalTokens` / `maxTotalCost` as the
  process-wide ceiling.

## Failure modes

| symptom | cause | fix |
|---|---|---|
| `401 unauthorized` from the CLI | client token missing or different from the server's | set `AGENTMESH_TEAM_TOKEN` (or `--token-env NAME`) for both |
| `team server returned 404: no such channel` | typo, or a DM for an unknown member | `agentmesh team channels` |
| nothing happens after `@someone` | they are not in that channel, or both caps were hit | check the system line in `team log` |
| a member never answers | its harness is not installed/authenticated | run that profile once outside the team; see `agentmesh list` |
| a member answers a message nobody addressed to it | it has `claims` on that channel, so unaddressed messages are offered to it | `team board` shows what it took; remove the channel from `claims` to stop it |
| a turn failed with `session ... busy` | a leftover task still holds the session | the team queues per member; if it persists, `agentmesh tasks` and let it settle |
| `interrupted` after a restart | the process stopped mid-turn | send the message again; queued work already resumed |

Related: [`configuration.md`](./configuration.md) for every key,
[`cli.md`](./cli.md) for commands, [`verification.md`](./verification.md) for what
the suite covers, [`remote.md`](./remote.md) if a member runs on another machine
through a `driver: remote` profile.
