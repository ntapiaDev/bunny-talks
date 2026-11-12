# ADR-001 — Responsabilités des packages cryptographiques

**Statut :** accepté ; frontières détaillées évolutives.

## Contexte

Les communications, le stockage local, les appareils et l'archive ont des responsabilités distinctes.

## Décision

`crypto-core` définit les contrats indépendants du SDK ; `crypto-engine` adapte le protocole. Le stockage, l'archive et les appareils relèvent de leurs responsabilités dédiées, introduites progressivement selon les besoins.

## Alternatives

Un package unique simplifierait la structure initiale, mais mélangerait domaine et infrastructure. Créer tous les packages immédiatement ajouterait des abstractions sans besoin concret.

## Conséquences

Les interfaces restent testables indépendamment ; leurs frontières précises pourront évoluer après validation du protocole.
