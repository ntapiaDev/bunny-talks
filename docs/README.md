# Index documentaire

Les documents marqués « référence » décrivent les décisions ou contrats applicables dans leur périmètre, mais ne certifient pas une mise en production. Les rapports historiques relatent les preuves et limites observées à leur date. En cas de différence, lire les actualisations et l'[état courant](development/current-milestone.md), puis les documents de référence ; ne pas interpréter une expérience comme une décision de production.

## Références actuelles

- Produit : [présentation et décisions](product/project-overview.md).
- Architecture : [vue d'ensemble](architecture/architecture-overview.md), [audit transversal 4.5B0 bis](development/monorepo-audit.md), [mobile](development/mobile-architecture.md) et [harmonisation backend](development/backend-architecture-harmonization.md).
- Sécurité : [modèle de menaces](security/threat-model.md) et [exigences d'archive et de récupération](security/encrypted-archive-and-recovery.md).
- Coffre implémenté à deux enveloppes : [enveloppes V1](security/key-envelopes-v1.md), [composition authentifiée V1](security/account-vault-v1.md) et [contrats de publication](development/vault-publication-contracts.md). Ces formats expérimentaux ne constituent pas un parcours complet de récupération.
- Compte et appareils : [sessions persistantes](development/persistent-sessions.md), [preuves de réauthentification](development/reauthentication-grants.md), [inscription](development/email-registration.md) et [premier amorçage](development/initial-device-bootstrap.md). L'autorisation serveur ne prouve pas la possession de l'identité E2EE.
- API : [sessions HTTP](development/http-sessions.md), [inscription HTTP](development/http-email-registration.md), [connexion HTTP](development/http-login.md), [amorçage HTTP](development/http-initial-device-bootstrap.md), [repository transactionnel](development/transactional-vault-repository.md) et [vérificateurs de mot de passe](security/server-password-verifiers.md).
- Mobile : [fondation HTTP applicative](development/mobile-application-http.md).
- Environnement : [PostgreSQL, migrations et suites dédiées](development/postgresql-prisma-foundation.md), [prérequis de qualification mobile](development/mobile-qualification-prerequisites.md).

## Évaluations expérimentales et qualifications

- [OpenE2EE 14.5.0 sur Android](development/mobile-open-e2ee-qualification.md), [coffre Android](development/android-vault-qualification.md), [Argon2id natif](development/native-argon2-qualification.md), [migration OpenE2EE 14.5.0](development/open-e2ee-14-5-migration.md) et [audit CRYPTO-001](development/crypto-fix-001-audit.md). Leurs résultats sont limités aux versions, appareils et scénarios observés ; la structure mobile 4.5B0 doit être requalifiée après arrêt forcé.
- [Coffre direct V1](security/recovery-vault-direct-v1.md), [charge candidate V1](security/recovery-payload-v1.md), [évaluation des composants](security/recovery-vault-component-evaluation.md) et [interopérabilité](security/recovery-vault-interop-evaluation.md) : travaux d'évaluation, distincts de la cible à deux enveloppes.

## Historique et documents remplacés

- [Historique intégral des jalons](development/milestone-history.md) : conclusions et contexte conservés, y compris les états révolus.
- [Audit de transition E2EE](architecture/e2ee-transition-audit.md) et [ADR-003](architecture/decisions/003-open-e2ee-evaluation.md) : contexte historique et actualisations de l'évaluation SDK. OpenE2EE demeure un candidat, pas un choix définitif.
- [Spécification de récupération initiale](security/recovery-vault-specification.md) et [prérequis techniques](security/recovery-vault-technical-prerequisites.md) : propositions et étapes historiques à lire avec leurs actualisations et la cible ci-dessous.

## Décisions et garanties encore ouvertes

- [Architecture cible de récupération](security/recovery-vault-architecture.md) et [hiérarchie d'archive candidate](security/archive-key-hierarchy.md) : les formats d'archive, la fraîcheur, la rotation et les parcours complets restent à définir ou valider.
- [ADR-001 : packages crypto](architecture/decisions/001-crypto-packages.md), [ADR-002 : identité partagée](architecture/decisions/002-shared-identity.md) et [ADR-003 : évaluation OpenE2EE](architecture/decisions/003-open-e2ee-evaluation.md) exposent les décisions et leurs réserves. SEC-CRYPTO-002 (import atomique et reprise sûre) et SEC-CRYPTO-003 (autorisation individuelle, authentification et anti-rejeu des appareils) restent bloquants avant production.
- La qualification iOS, les appareils physiques, les builds release, le relay réel et la sécurité d'ensemble restent ouverts. Les suites Node, PostgreSQL ou Metro ne les démontrent pas.
