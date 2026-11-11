# Bunny Talks — Development Instructions

## Project

Bunny Talks is a mobile-first social application focused on
meaningful relationships, correspondence, and shared spaces.

The application is not a dating platform.

## Language

- Communicate with the developer in French.
- Write source code, identifiers, and technical comments in English.
- Follow existing repository conventions.

## Architecture

- Use TypeScript with strict type checking.
- Follow Clean Architecture principles.
- Keep domain logic independent of frameworks and infrastructure.
- Use reusable packages within the pnpm monorepo.
- Prefer simple, maintainable solutions over premature abstractions.
- Respect documented architectural and product decisions.
- Do not silently change an established decision.

## Technology

- Node.js 24 and pnpm 10.34.9.
- React Native and Expo Development Builds for mobile.
- NestJS, Prisma, and PostgreSQL for the backend.
- Vitest for automated testing.
- Ubuntu WSL as the development environment.

## Cryptography

Cryptographic correctness and security take priority over speed.

- Never implement custom cryptographic primitives.
- Treat OpenE2EE 14.4.0 as an SDK under evaluation.
- Do not assume SDK compatibility without verification.
- Inspect installed source code and public TypeScript declarations.
- Prefer documented public APIs over internal implementation details.
- Keep SDK-specific code isolated from crypto-core.
- Never expose private keys, recovery secrets, or plaintext
  sensitive data in logs.
- Never weaken security requirements to make a test pass.
- Explicitly distinguish verified behavior from assumptions.

The intended account model includes:

- A durable cryptographic identity shared by trusted devices.
- Device-specific sessions and registration identifiers.
- Secure device enrollment and revocation.
- Encrypted history accessible to newly authorized devices.
- Independent encrypted recovery after loss of all trusted devices.

These requirements are not yet validated against the SDK.

## Implementation

- All experiments must produce reusable production-oriented code.
- Avoid throwaway prototypes and duplicated implementations.
- Make small, coherent, reviewable changes.
- Preserve existing work and uncommitted modifications.
- Do not install dependencies without explaining why.
- Do not introduce breaking changes without explicit approval.
- Do not create commits unless requested.

## Quality

When relevant, run:

- pnpm typecheck
- pnpm lint
- pnpm test
- pnpm format:check

Add automated tests for new behavior, including failure cases.
Report which checks ran and which could not be verified.

## Git

- Use Conventional Commits.
- Recommend an appropriate commit message at each coherent milestone.
- Never commit secrets, credentials, or generated sensitive material.
- Never discard or overwrite existing changes without approval.

## Documentation

Consult these files before significant architectural changes:

- docs/product/project-overview.md
- docs/architecture/architecture-overview.md
- docs/security/encrypted-archive-and-recovery.md
- docs/security/threat-model.md

Update documentation when implementation changes an established
technical contract or introduces a significant architectural decision.

## Reporting

At the end of each implementation task, summarize:

1. What changed.
2. Which files were affected.
3. Which tests and checks passed or failed.
4. Remaining risks or unresolved questions.
5. Suggested Conventional Commit message, when appropriate.
