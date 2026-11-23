# Task-response latency tuning: worker reasoning effort

This patch reduces the end-to-end latency of dsh-superagent task requests by lowering the
reasoning effort of worker sessions, which is the dominant cost of a multi-round ticket.

## Root cause

The deployment runs `deepseek-v4-pro` with `reasoningEffort: high` as the profile default.
The orchestrator and the worker both inherit that default (`eval.model` and `executor.model`
are unset). A task request opens a worker session that runs many rounds — read context,
investigate, implement, verify, report — and each round paid the full `high` reasoning cost.
Simple chat was already routed to a single-round direct answer, but any request that looks up
information or runs tools still paid `high` on every round, which measured 6–23 minutes.

## Change

When `executor.model` is unset, a worker session now keeps the deployment's default route
(provider and model) but runs at `low` reasoning effort. DSH's model catalog describes `low`
as "Prefer for routine or latency-sensitive tasks", which is exactly what worker turns are.
The orchestrator (`eval.model`) keeps the deployment default, so the quality-critical
assessment and routing stay at `high`.

- `src/app/role-models.ts` — adds `WORKER_DEFAULT_REASONING_EFFORT = 'low'` and a
  `defaultReasoningEffort` parameter to `initializeRoleModel`; when no role model is set it
  registers an `agent/request` hook that only overrides `reasoningEffort`, leaving the route
  inherited. An explicit session selection (a request header or `model/selection`) still wins.
- `src/app/sessions.ts` — passes `'low'` for the worker role and `undefined` for the
  orchestrator.
- `tests/role-models.spec.ts` — covers the new default-effort path.
- `docs/006-deployment.md` — documents the default and how to override it.

Setting `executor.model` with an explicit `reasoningEffort` still overrides the default.

## Verification

- `pnpm typecheck` — passes.
- `pnpm vitest run tests/role-models.spec.ts` — 6 passed.
- `pnpm test` — 1198 passed; the 2 remaining failures in `tests/runtime.spec.ts` are a
  pre-existing environment leak (`GIT_CONFIG_GLOBAL` is set in the worker shell) and pass when
  that variable is unset, unrelated to this change.
- `pnpm build` — passes.

## Applying

Apply `worker-low-reasoning.patch` to the dsh-superagent source, rebuild, and restart the
superagent host. The change takes effect for worker sessions created after the restart;
existing sessions keep their model.
