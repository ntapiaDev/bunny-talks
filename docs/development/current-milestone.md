# Jalon CRYPTO-010 — Caractérisation des composants de sécurité

**Statut :** essais de caractérisation Node et recommandations pour revue ; aucune API de coffre ni dépendance de production ajoutée.

## Résultats

L'[évaluation des composants](../security/recovery-vault-component-evaluation.md) décrit les tests de `jsonc-parser` 3.3.1, `canonicalize` 5.0.0 et `json-canonicalize` 3.0.1, ajoutés uniquement en dépendances de développement. Les tests couvrent des exemples RFC 8785 et les octets du vecteur CRYPTO-008. Ils caractérisent des composants, pas un validateur V1 complet.

La stratégie d'aléa explicite exige l'échec fermé et interdit les chemins `Math.random`, y compris en développement. Les cas de repli Expo et React Native documentés restent à vérifier sur les versions et builds mobiles effectivement retenus.

## Conditions ouvertes

- Tester les limites d'allocation du parseur, le corpus JCS complet et le fuzzing ; choisir et examiner les dépendances avant toute utilisation de production.
- Vérifier les fournisseurs, l'UTF-8 et les vecteurs sur Expo Development Builds et Hermes, iOS et Android ; aucune compatibilité mobile ni preuve d'entropie n'est établie par Node.
- Décider les responsabilités et dépendances du futur `@bunny-talks/crypto-backup` avant création ; concevoir stockage, reprise et fraîcheur.
- **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants avant production.**

Attendre la revue ; ne pas commencer CRYPTO-011 automatiquement.
