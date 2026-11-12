# ADR-003 — Évaluation d'OpenE2EE 14.4.0

**Statut :** en évaluation ; aucun choix de production définitif.

## Contexte

Le projet examine les capacités du SDK pour le modèle multi-appareils et la récupération.

## Proposition

Isoler OpenE2EE 14.4.0 dans `crypto-engine` et vérifier ses API publiques, son comportement et sa compatibilité mobile avant toute décision de production.

## Alternatives

D'autres bibliothèques, notamment libsignal, restent candidates ; choisir maintenant sans intégration ni audit suffisant serait prématuré.

## Conséquences

Les essais doivent rester réutilisables et couvrir les pannes. La cohérence d'une paire de clés ne prouve pas l'authenticité de sa provenance. Les divergences de bornes de registration ID et la compatibilité native restent à résoudre.
