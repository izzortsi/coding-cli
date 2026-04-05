# Engineering Principles

Core architectural and design doctrine for agent-driven development. These principles are language-agnostic and framework-independent.

---

## 1. Separation of Concerns

Logic, parsing, state management, and I/O belong in the processing layer. Display and input capture belong in the presentation layer.

A common failure mode is stuffing processing logic into UI components because "it works." Even working code from a reference implementation must be audited for correct placement. The question is never "does it run?" but "does it belong here?"

## 2. Pure Data

Data should be simple, inert structures. Functions should be standalone transformations.

- **Data is pure:** Use simple types and discriminated unions. No methods on data objects.
- **Functions are standalone:** Transform data via explicit, greppable standalone functions.
- **Composition over factories:** Do not bake use-cases into factories. Provide primitives and let callers compose them. Special cases should not exist at the factory level.

The instinct to create "behavioral objects" and "factory functions with baked-in assumptions" must be resisted. It conflates data with the operations on data, creating coupling and hidden complexity.

## 3. Two-Phase Authorization

Separate approval from execution. Approval computes a token; application consumes it.

The gap between approval and execution creates **agency**. The actor must observe the permission and affirmatively decide to use it. At execution time, the actor provides a description explaining *why* they are acting. System-generated logs record *what*; actor-generated descriptions record *intent*.

This applies to any system where actions have consequences that benefit from an audit trail.

## 4. Context Filtering

Storage preserves truth. Presentation preserves safety.

- **Storage:** Never corrupt the audit trail. Store exactly what happened.
- **Presentation:** Filter invalid or dangerous content at the compilation/presentation layer before exposing it. An agent must never see invalid patterns that could be mimicked.
- **Dormancy over corruption:** Use flags to omit content from view. Content corruption (replacing with empty strings, newlines) is lossy and permanent. Flagging is clean, auditable, and reversible.

## 5. Declarative State

Say "my state is now X," not "change Y to Z."

- **Declare, don't modify:** Differential verbs invite complexity. Declarative state is easier to reason about, replay, and audit.
- **Derive, don't store:** If a value can be computed from authoritative sources, do not store it. Stored derived state is a cache invalidation bug waiting to happen. Compute on demand.

Prefer declarative assertions over differential mutations. Prefer computation over cached copies.

## 6. No Implicit Defaults

Every operational path must be an explicit, declared member of the contract. "Default" behavior is not the absence of configuration -- it is a configuration that happens to be common.

- **All paths are first-class:** Every operational path must be declared.
- **No privileged bypasses:** If a caller can omit a declaration and get fallback behavior, you have created a hidden path. Hidden paths break composability and invite bugs.
- **Composability requires uniformity:** When all paths flow through the same machinery, they can compose. When some paths bypass the machinery, composition breaks.

If there is a "special case that does not need to be declared," that special case is a bug.

## 7. Meta-Information Separation

Schemas describe only what the user or agent provides. System context (identity, auth, timing, channel) is injected by the system out-of-band.

- **Schema = data contract:** Validated user/agent-provided data.
- **Context = system plumbing:** Trusted, not validated. Injected separately.
- **Handler signature:** `(params, context)` -- params are user data, context is system data. All handlers receive context; whether they use it is their business.

Infrastructure concerns must never pollute domain contracts.

## 8. Structural Enforcement Over Convention

If separation matters architecturally, enforce it structurally -- repository boundaries, process boundaries, package boundaries with distinct publication, filesystem isolation. Do not rely on documented rules that can be unknowingly violated.

- Convention is appropriate for preference. Structure is required for invariants.
- **The test:** "Can this boundary be violated by someone who does not know the rule?" If yes, it is convention. If no, it is structure.

Social contracts erode. Physical constraints persist.

## 9. No Destructive Operations in Audit Systems

In systems where historical state has audit value, destruction is a category error. A reference at any log position is sacred.

**Non-destructive alternatives:**
- Export/bundle: package reachable content
- Mirror compaction: build new store, keep old frozen
- Quarantine/archive: move, never delete; restore-capable

Append-only means append-only. Historical state is part of the audit trail and must survive indefinitely.

## 10. Clean Slate in Bootstrap

In a new project, all code is current. There is no "old version" to support.

- **No facades:** Do not create wrappers just to preserve old API signatures. Update the consumers.
- **No dual-writes:** Never maintain two sources of truth to "be safe." It doubles the state surface area and invites desynchronization.

Backward compatibility infrastructure in a project that has no backward compatibility obligations is pure waste.
