# Audit transversal du monorepo — 4.5B0 bis

## Dépendances et responsabilités

Les dépendances ci-dessous correspondent aux imports des sources, indépendamment des dépendances de test et des transitives :

| Source          | Packages internes utilisés                 | Responsabilité                                                              |
| --------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `apps/api`      | `contracts`, `validation`, `crypto-backup` | Composition NestJS, HTTP, règles de compte et persistance Prisma/PostgreSQL |
| `apps/mobile`   | `crypto-engine`, `crypto-backup`           | Composition Expo, diagnostics expérimentaux et adaptateurs natifs           |
| `contracts`     | aucune                                     | Types de transport partagés                                                 |
| `validation`    | aucune                                     | Validation des entrées avec Zod                                             |
| `crypto/core`   | aucune                                     | Types et règles crypto indépendants du SDK                                  |
| `crypto/engine` | `crypto-core`                              | Adaptation et validation autour d'OpenE2EE                                  |
| `crypto/backup` | aucune                                     | Enveloppes, coffre et transitions structurelles                             |

Les types de transport et les schémas de validation se recoupent par rôle sans être interchangeables : l'un décrit les types, l'autre contrôle des entrées à l'exécution. Les rassembler créerait un changement de contrat non justifié par cet audit. Le graphe des sources, incluant les imports de types et entrées de packages, est contrôlé sans cycle par les tests d'architecture API. Les packages n'importent ni application ni framework applicatif ou persistance ; le mobile complète cette protection pour les manifests et contrôle la présentation et l'initialisation native. Ces contrôles statiques ne remplacent pas une analyse complète des dépendances dynamiques.

Les packages exposent leurs entrées construites `dist` via leurs manifests ; `crypto-backup/experimental` sépare les API historiques de la racine. Leurs tests couvrent les contrats et notamment les exports du coffre. Le workspace utilise TypeScript strict, NodeNext pour l'API et les packages, Bundler pour Expo. Les scénarios mobiles utilisent aussi directement les entrées publiques SDK déclarées dans les exports d'OpenE2EE 14.5.0 et les fixtures publiques de `crypto-backup` ; les tests de `crypto-backup` réutilisent également une fixture de `crypto-engine`. Ces références de qualification ne créent pas de dépendance produit inverse.

## Constats

- **Bloquant identifié pour cette consolidation :** aucun changement de sécurité ou de contrat public nécessaire n'a été établi. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent toutefois bloquants avant production.
- **Cohérence corrigée :** les points d'entrée documentaires et le statut courant étaient dispersés parmi les rapports historiques. L'index, le README et un historique séparé explicitent maintenant les sources et les limites.
- **Facultatif :** Metro redirige `jsonc-parser` vers `jsonc-parser/lib/esm/main.js`, son champ `module` publié en 3.3.1. Ce chemin et sa résolution transitive via `crypto-backup` peuvent devenir fragiles lors d'une mise à jour ; l'export Metro actuel le vérifie, sans garantir une autre version. Ne pas ajouter une dépendance ni modifier ce contournement sans besoin et qualification. Les tests mobile et API vérifient tous deux les cycles mobiles ; cette redondance est faible et permet au test mobile de rester autonome.
- **Différé :** requalification Android après déplacement, iOS, appareils physiques, release, relay réel, restauration complète, provenance et sécurité du fournisseur natif et conception des garanties crypto ouvertes. Les suites d'intégration PostgreSQL requièrent une instance de test dédiée avec les garde-fous documentés.

Aucun code cryptographique, format, migration, contrat HTTP ou projet natif n'est modifié dans ce jalon. Les noms des stores, leurs données et les vecteurs sont conservés. Les sources de vérité et le statut des documents sont regroupés dans [l'index](../README.md).
