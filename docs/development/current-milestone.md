# Jalon CRYPTO-006 — Spécification candidate du coffre de récupération

**Statut :** proposition documentaire pour revue ; aucun format, fournisseur ou profil cryptographique n'est validé pour la production.

## Objectif et résultat

La [spécification candidate](../security/recovery-vault-specification.md) sépare un coffre générique et une couche d'identité Bunny Talks ; elle propose une enveloppe versionnée, un profil HKDF-SHA-256 et XChaCha20-Poly1305, des contrats TypeScript illustratifs, des conditions de validation, une stratégie de reprise et un plan de tests. Aucun package ni code de production n'est créé.

La revue finale compare chiffrement direct et enveloppement d'une clé indépendante : ce dernier reste le candidat décrit, avec ses coûts et sans avantage de rotation du seul emballage dans la proposition actuelle. Les contrats d'erreur, le parseur canonique, les limites candidates, la génération du coffre, la révision de stockage et la référence indépendante de fraîcheur sont explicités.

Les résultats expérimentaux de CRYPTO-005 restent documentés dans l'[architecture du coffre](../security/recovery-vault-architecture.md) : ils caractérisent des primitives sous Node et ne démontrent ni la composition proposée ni la compatibilité mobile.

## Critères de revue

- Examiner la composition à deux clés, les données authentifiées, les limites et les encodages ; comparer un format standard existant et obtenir une revue cryptographique indépendante avant adoption.
- Valider les frontières des packages et les contrats proposés, la charge métier et les secrets d'archive sans changer les API existantes pendant ce jalon.
- Définir la source fiable du compte attendu, l'ancre de fraîcheur, la publication conditionnelle, la rotation et la reprise ; examiner la perte de tous les appareils.
- Préparer des vecteurs de composition et des tests indépendants, de robustesse, de concurrence et des tests Expo Development Builds réels avant production.

## Blocages et décisions ouvertes

**SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants** pour l'association ou la récupération en production. La possession d'une identité ou d'un coffre ne vaut pas autorisation individuelle. Une génération dans l'enveloppe n'empêche pas seule le retour arrière.

Le profil, la bibliothèque, les limites finales, la représentation humaine du secret, le format, les références de compte et de fraîcheur, le contenu de l'archive et les modalités de publication restent à valider. Les résultats CRYPTO-005 ne constituent pas un audit ni une validation Hermes/iOS/Android.

## Suite

Attendre la revue de cette spécification et une décision explicite avant implémentation. Ne pas démarrer CRYPTO-007 automatiquement.
