---
id: 2026-05-06-auth-token-expiry
title: Auth token expires silently
kind: issue
column: discovered
phase: unassigned
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-06T12:34:56Z
source: user
labels:
  - auth
  - regression
blocked_by: []
---

# Original Issue

When a user's auth token expires, the application returns a 500 instead
of redirecting to login. Affects all `src/auth/` paths.
