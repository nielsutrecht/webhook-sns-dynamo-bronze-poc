## ADDED Requirements

### Requirement: Infrastructure code is split into focused component files
The Pulumi infrastructure code SHALL be organised into a set of focused files, each with a single responsibility. The entry point `index.ts` SHALL contain only component instantiation and stack output exports.

#### Scenario: index.ts is a thin composition root
- **WHEN** a developer opens `index.ts`
- **THEN** it contains only imports, component instantiation, and `export` statements (no resource definitions)

#### Scenario: Each component file covers one pipeline area
- **WHEN** a developer needs to modify a resource in a given pipeline stage
- **THEN** there is exactly one component file that owns all resources for that stage

### Requirement: Components use pulumi.ComponentResource
Each component SHALL extend `pulumi.ComponentResource` and expose its outputs as typed public properties.

#### Scenario: Component outputs are accessible as typed properties
- **WHEN** one component depends on a resource from another component
- **THEN** the dependency is satisfied via a public property on the source component (not via a global variable or module-level export)

#### Scenario: Pulumi graph shows component grouping
- **WHEN** running `pulumi preview` or `pulumi up`
- **THEN** child resources are listed under their parent component name in the output

### Requirement: Shared helpers are importable from a single location
The `lambdaRole()` and `lambdaCode()` helpers SHALL be defined in `utils.ts` and imported by any component that needs them.

#### Scenario: No duplication of helper functions
- **WHEN** searching the codebase for `function lambdaRole`
- **THEN** exactly one definition exists (in `utils.ts`)

### Requirement: Stack config is centralised in config.ts
`stackName` and any Pulumi config values SHALL be exported from `config.ts`.

#### Scenario: stackName has a single definition
- **WHEN** searching the codebase for `pulumi.getStack()`
- **THEN** exactly one call exists (in `config.ts`)

### Requirement: Refactor produces no infrastructure diff
After the refactor, running `pulumi preview` against an existing stack SHALL report no planned changes.

#### Scenario: pulumi preview shows no-op
- **WHEN** `pulumi preview` is run after the refactor against a deployed stack
- **THEN** the output reports "0 to create, 0 to update, 0 to delete"
