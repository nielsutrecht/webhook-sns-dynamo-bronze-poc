## Why

The entire infrastructure is defined in a single 835-line `index.ts`. As new pipeline stages have been added (silver, gold, Metabase), the file has grown into an undifferentiated block that is hard to navigate, review, and extend. Splitting it into focused components makes the ownership boundaries explicit and keeps each file at a readable size.

## What Changes

- `index.ts` is reduced to a ~40-line composition root that wires components together and exports stack outputs
- `config.ts` is introduced to centralise `stackName` and Pulumi config values (e.g. `developerCidr`)
- `utils.ts` is introduced for the shared `lambdaRole()` and `lambdaCode()` helpers
- Five `ComponentResource` classes are extracted into `components/`:
  - `StorageComponent` — all S3 buckets
  - `IngestionComponent` — SNS topic, Firehose delivery stream, transform Lambda
  - `DynamoSinkComponent` — SQS + DLQ, DynamoDB table, DynamoDB subscriber Lambda
  - `AnalyticsComponent` — Glue database, Athena workgroup, silver trigger queue + DLQ, orchestrator Lambda
  - `MetabaseComponent` — EC2 instance, EBS, security group, auto-stop Lambda, CloudWatch alarm

No AWS resources are added, removed, or renamed — this is a pure structural refactor.

## Capabilities

### New Capabilities

None. This change does not introduce new runtime behaviour.

### Modified Capabilities

None. All existing spec-level requirements are unchanged; only the infrastructure code organisation changes.

## Impact

- `index.ts` — rewritten (composition root only)
- `config.ts` — new file
- `utils.ts` — new file
- `components/storage.ts` — new file
- `components/ingestion.ts` — new file
- `components/dynamo-sink.ts` — new file
- `components/analytics.ts` — new file
- `components/metabase.ts` — new file
- No changes to Lambda handler source code (`src/`)
- No changes to Pulumi stack config, outputs, or resource logical names
- `pulumi up` after this refactor is a no-op (no planned diff)
