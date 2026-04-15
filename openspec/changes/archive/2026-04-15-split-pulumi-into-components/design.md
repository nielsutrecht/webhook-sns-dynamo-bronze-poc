## Context

`index.ts` has grown to 835 lines as five Lambda functions and four pipeline stages were added incrementally. Every AWS resource — S3 buckets, SNS, SQS, Firehose, DynamoDB, Glue, Athena, EC2, CloudWatch — is defined in a single flat file with no structural grouping beyond comments. Two helper functions (`lambdaRole`, `lambdaCode`) are defined inline but can only be used within that file.

The refactor is purely structural: no resources are added, removed, or renamed.

## Goals / Non-Goals

**Goals:**
- Each component file is independently readable (≤ ~200 lines)
- `index.ts` is a thin composition root (~40 lines)
- IAM policies remain co-located with the resources they serve
- Shared helpers (`lambdaRole`, `lambdaCode`) are importable by any component
- Stack config extraction is centralised
- `pulumi up` produces a no-op diff after the refactor

**Non-Goals:**
- No new AWS resources or runtime behaviour
- No changes to Lambda handler source code (`src/`)
- No changes to resource logical names (preserves Pulumi state)
- No introduction of Pulumi `Stack References` or remote state

## Decisions

### 1. Use `pulumi.ComponentResource` for each component

**Decision:** Each component extends `pulumi.ComponentResource` rather than being a plain module that exports variables.

**Rationale:** `ComponentResource` groups child resources under a named parent in the Pulumi graph, making `pulumi preview` and `pulumi up` output easier to read. It also enforces an explicit input/output contract via constructor args and public properties.

**Alternative considered:** Plain TypeScript modules with named exports. Simpler, but produces a flat resource graph and no enforced interface boundary between components.

### 2. Five components, split by pipeline stage / functional area

**Decision:**
- `StorageComponent` — S3 buckets
- `IngestionComponent` — SNS + Firehose + transform Lambda
- `DynamoSinkComponent` — SQS + DynamoDB + subscriber Lambda
- `AnalyticsComponent` — Glue + Athena + trigger queue + orchestrator Lambda
- `MetabaseComponent` — EC2 + security group + auto-stop Lambda + alarm

**Rationale:** Splits follow natural ownership boundaries in the architecture. Each component maps to a distinct part of the data pipeline or operational concern.

**Alternative considered:** Splitting by AWS service type (all SQS in one file, all Lambda in another). Rejected — it scatters logically related resources across files and obscures the pipeline structure.

### 3. `config.ts` for shared configuration

**Decision:** Extract `stackName` (`pulumi.getStack()`) and `developerCidr` into a `config.ts` module.

**Rationale:** `stackName` is used by every component to name resources. Centralising it avoids passing it as a constructor arg to every component and prevents drift.

### 4. `utils.ts` for shared Lambda helpers

**Decision:** Move `lambdaRole()` and `lambdaCode()` to a top-level `utils.ts`.

**Rationale:** Currently duplicable only by copy-paste. Extracting them makes them importable by all component files without circular dependencies.

### 5. IAM policies stay inside each component

**Decision:** Do not create a separate `iam/` directory.

**Rationale:** At this scale (5 components), keeping IAM co-located with the resources it governs is clearer than a separate file. A dedicated `iam/` layer adds indirection without benefit until policies are shared across multiple components.

## Risks / Trade-offs

**[Risk] Pulumi resource rename causes replacement** → All `ComponentResource` logical names must match the originals exactly. For example, the webhook Lambda must remain `"webhook-publisher"`, not `"ingestion-webhook-publisher"`. Mitigation: preserve the exact string passed to each `new aws.*.*()` call; only the surrounding TypeScript structure changes.

**[Risk] Circular import between components** → `AnalyticsComponent` depends on `StorageComponent` outputs; `MetabaseComponent` depends on both. Mitigation: all cross-component dependencies flow through constructor args typed as Pulumi resource objects. No component imports another component module directly.

## Migration Plan

1. Create `config.ts` and `utils.ts`
2. Create each component file, moving resources from `index.ts` one component at a time
3. Rewrite `index.ts` as the composition root
4. Run `pulumi preview` — expected: no changes
5. Commit

Rollback: revert commits; the original `index.ts` is fully self-contained.

## Open Questions

None — this is a well-scoped structural refactor with no ambiguous decisions.
