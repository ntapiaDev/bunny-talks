# Jalon CRYPTO-009 — Prérequis du coffre direct V1

**Statut :** caractérisation Node et comparaison documentaire pour revue ; aucune API de coffre ni dépendance de production ajoutée.

## Résultats

L'[investigation des prérequis](../security/recovery-vault-technical-prerequisites.md) compare des parseurs et sérialiseurs JCS candidats, précise les contrôles à combiner et caractérise les comportements JSON/UTF-8 et aléa Noble disponibles sous Node. Elle documente les replis `Math.random` identifiés dans certains chemins de développement Expo et React Native, incompatibles avec les exigences de sécurité.

Le vecteur de l'[enveloppe directe V1](../security/recovery-vault-direct-v1.md) reste expérimental. Les candidats de parsing et JCS ne sont pas installés ni testés ; aucun résultat ne démontre Hermes ou Expo et aucun audit n'a été effectué.

## Conditions ouvertes

- Choisir et évaluer un parseur et un sérialiseur, leurs versions et licences ; exécuter les vecteurs RFC 8785, les tests d'entrées hostiles, de limites et les tests différentiels sur Node et mobiles.
- Sélectionner et vérifier la source d'aléa et ses chemins de débogage sur Expo Development Builds iOS et Android ; absence ou erreur doit provoquer un échec fermé, sans repli prévisible.
- Décider les frontières et dépendances du futur `crypto/backup` avant sa création ; ne pas promouvoir Noble automatiquement en dépendance de production.
- Définir stockage, fraîcheur, concurrence, reprise et charge durable ; **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants avant production**.

Attendre la revue ; ne pas commencer CRYPTO-010 automatiquement.
