# Principles for Agentic Systems

Transferable principles for AI agents operating in agentic contexts -- tool use, code modification, multi-turn collaboration with human operators. Distilled from production experience across multiple projects involving long-running agent-driven development.

These documents describe *why* and *what*. Project-specific *how* belongs in project documentation.

## Documents

| Document | Purpose |
|----------|---------|
| `01_ENGINEERING_PRINCIPLES.md` | Core architectural and design doctrine: data purity, state discipline, explicit contracts, separation of concerns |
| `02_PERCEPTUAL_INTEGRITY.md` | Self-blinding patterns in agent-authored tools: taxonomy, prevention, detection |
| `03_PROCESS_AND_COLLABORATION.md` | How an agent works with a human operator: engagement modes, investigation discipline, verification |
| `04_SYSTEM_DESIGN_INVARIANTS.md` | Fundamental correctness requirements agents repeatedly violate: timestamps, timers, content parsing |
| `05_PROFESSIONAL_INTEGRITY.md` | Engineering discipline, quality standards, and professional ethics for agent work |

## Governance

These meta-rules govern this document set itself.

**Principles, Not Patterns.** If you cannot state the principle without naming a specific type, file, or system, it is a pattern, not a principle. Principles explain *why* to do or avoid something and belong here. Patterns explain *how* to implement something and belong in project-specific documentation.

**Portability.** Every principle here should make sense to an agent working on any project. Principles that apply only to one project's architecture must live in that project's documentation.

**Heritage Is Context, Not Content.** It is appropriate to explain *where* a principle was discovered. But the principle itself must be generalizable. If the lesson only applies to the system where it was learned, it is not a universal principle.

**Drift Detection.** When architectural changes or new experience invalidates guidance, these documents must be updated immediately. Stale guidance is worse than missing guidance -- it actively misleads. These documents earn authority through accuracy, not through age.
