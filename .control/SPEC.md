# Project Spec

> **Canonical project spec (Control v2.0).** Source of truth for scope, architecture, decisions, and design rules. Distilled docs (`.control/architecture/phase-plan.md`, per-phase READMEs) derive from this file; when they disagree, this file wins.
>
> **Spec evolution lives in this file's git history.** Amend with `/spec-amend <slug>` to append a dated artifact section under "Artifacts (chronological)" below — OR edit the canonical sections directly when reframing fundamentals. Either way, `git log .control/SPEC.md` is the authoritative history.
>
> *(v2.0 collapsed the v1.3 layout of `.control/spec/SPEC.md` + `.control/spec/artifacts/` + `.control/architecture/overview.md` into this single file. See README.md "Migration from v1.3" section for the upgrade path.)*

---

## Overview

<One paragraph — the project's identity. Problem, audience, headline outcome. Distilled enough that a reader catches the shape in 30 seconds. Replaces v1.3's `architecture/overview.md`.>

## Problem statement

<One paragraph — the specific pain or gap this project exists to solve.>

## Scope

- **In scope:** <...>
- **Out of scope:** <...>

## Tech choices

<Major decisions: language, key frameworks, storage, distribution. Each non-trivial choice should also have an ADR in `.control/architecture/decisions/`.>

## High-level architecture

<Diagram (Mermaid) or prose describing the main components and how they interact.>

## Key interfaces

<Module contracts, DB schemas, API shapes. Detailed contracts in `.control/architecture/interfaces/` if separated.>

---

## Artifacts (chronological)

<!-- Spec evolutions over time, appended by /spec-amend <slug>. Newer artifacts
take precedence over older content in the canonical sections above. The commit
log of this file (`git log .control/SPEC.md`) is the authoritative history;
this section is the in-document view. -->

<!-- Use /spec-amend <slug> to add a new artifact here. -->
