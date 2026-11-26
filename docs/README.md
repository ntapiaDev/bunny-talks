# Index documentaire

Le [jalon courant](development/current-milestone.md) retrace l’état du pilotage. Les références ci-dessous fixent les décisions ou contrats applicables. Les résultats de code et de qualification se vérifient dans les tests et rapports associés.

## Décisions et contrats

- Produit, identité durable et relation de confiance. [Présentation du produit](product/project-overview.md), [ADR-002](architecture/decisions/002-shared-identity.md).
- Architecture du monorepo et des applications. [Vue d’ensemble](architecture/architecture-overview.md), [architecture mobile](development/mobile-architecture.md), [ADR-001](architecture/decisions/001-crypto-packages.md).
- Menaces, archive et récupération. [Modèle de menaces](security/threat-model.md), [exigences de récupération](security/encrypted-archive-and-recovery.md). SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.
- Comptes et sessions. [Inscription et identité e-mail](development/http-email-registration.md), [connexion](development/http-login.md), [sessions](development/http-sessions.md), [réauthentification](development/reauthentication-grants.md), [vérificateurs de mot de passe](security/server-password-verifiers.md).
- Amorçage et coffre V1 expérimental. [Amorçage initial](development/http-initial-device-bootstrap.md), [publication](development/vault-publication-contracts.md), [persistance transactionnelle](development/transactional-vault-repository.md), [enveloppes](security/key-envelopes-v1.md), [composition authentifiée](security/account-vault-v1.md).
- HTTP mobile. [Contrat applicatif et reprises métier](development/mobile-application-http.md), [ADR-004](architecture/decisions/004-bounded-mobile-api-responses.md).

## Mise en œuvre et qualifications

- Environnement serveur et suites isolées. [PostgreSQL et Prisma](development/postgresql-prisma-foundation.md).
- Préparation, campagnes et limites mobiles. [Prérequis](development/mobile-qualification-prerequisites.md), [qualifications HTTPS et oracles](development/native-https-foundation.md).
- Observations cryptographiques historiques. [Migration OpenE2EE](development/open-e2ee-14-5-migration.md), [OpenE2EE Android](development/mobile-open-e2ee-qualification.md), [coffre Android](development/android-vault-qualification.md), [Argon2id natif](development/native-argon2-qualification.md).
- Jalons, sources historiques et restauration. [Chronologie](development/milestone-history.md), [conservation HTTPS et documents consolidés](development/https-archive-index.md).

## Conceptions et évaluations ouvertes

- Évaluation OpenE2EE 14.4.0 et poursuite expérimentale en 14.5.0. [ADR-003](architecture/decisions/003-open-e2ee-evaluation.md), [audit de transition](architecture/e2ee-transition-audit.md).
- Récupération et archive. [Architecture cible et limites expérimentales](security/recovery-vault-architecture.md), [enveloppes actuelles](security/key-envelopes-v1.md), [composition V1](security/account-vault-v1.md), [hiérarchie candidate](security/archive-key-hierarchy.md), [charge candidate](security/recovery-payload-v1.md).
- Format direct historique conservé avec son code et ses vecteurs : [coffre direct V1](security/recovery-vault-direct-v1.md). Ses critères expérimentaux utiles sont résumés dans l'architecture du coffre ; ce format n'est pas la cible actuelle.
