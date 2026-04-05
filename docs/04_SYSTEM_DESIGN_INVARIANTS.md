# System Design Invariants

These principles address fundamental failures in system design that agents repeatedly introduce despite their obviousness to experienced engineers. They are not style preferences -- they are correctness requirements.

---

## 1. Timestamps Are Not Sequence, Identity, or Truth

Timestamps record when a clock said something was recorded. They are not sequence indicators, identity markers, or stable system data.

**Internal mutability:**
- Messages can be rearranged, imported, transposed
- Content can be edited without timestamp updates
- Batched operations may share timestamps despite having order

**External instability:**
- Clock drift between machines
- Timezone misalignment between systems
- Filesystem operations that touch/reset timestamps
- System clock modifications
- Import/export operations that lose or translate time data

**The design failure:** Any system behavior that executes policy based on timestamps is almost certain to break. It is not suboptimal -- it is invalid design. Closer to sabotage than infrastructure.

**What to use instead:** Explicit sequence numbers (monotonic, controlled), causal chains (happens-before relationships), UUIDs for identity, single-threaded deterministic ordering where needed.

## 2. Timer-Based Solutions Are Not Solutions

Agents repeatedly propose `setTimeout`, `sleep`, or "wait then check" as solutions to coordination problems. These are race conditions wearing a disguise.

- **A timer is an admission:** "I do not know when X will be ready, so I will guess." The guess will eventually be wrong.
- **Timers "work" until:** Load spikes, slow disks, network hiccups, resource contention, or any deviation from the assumed timing.

**Proper solutions use:**
- Events/callbacks (react when ready)
- Promises/futures (chain on completion)
- State machines (explicit transitions)
- Semaphores/locks (coordination primitives)

**The only valid uses of timers:**
- Timeouts (upper bounds on waiting, not expected completion times)
- Polling as a fallback when no event mechanism exists (with explicit acknowledgment of the limitation)
- Human-facing delays (animations, debouncing)

## 3. Content Parsing Is Almost Never Valid

Agents routinely propose parsing logs, command output, rendered text, or UI artifacts to extract state -- rather than accessing the authoritative data source directly.

**If you need state, get it from where the state lives.** Not from its rendered representation.

**Parsing creates:**
- Coupling to presentation format (fragile)
- Loss of type safety
- Ambiguity when formats change
- Working around the real problem rather than solving it

**The fix is always:** Find where the data actually lives and access it properly. Parsing is a workaround that accumulates debt.

**When content inspection is valid:** Sometimes it is necessary. But it should never be the first instinct. Such solutions must be explicitly surfaced to and negotiated with the operator. Even with authorization, if a cleaner path could exist, surface and advocate for that instead.
