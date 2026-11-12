# Jalon CRYPTO-001 — Validation des identités exportées

**Statut :** en revue.

## Critères d'acceptation

- Fournir une validation du format et de la correspondance des paires X25519 et Ed25519, à appeler avant toute écriture lors d'un futur import.
- Utiliser des API publiques et des dépendances explicites, sans exposer les secrets.
- Couvrir les entrées valides et invalides par des tests ; vérifier le package compilé.

## Limites et suites

- La validation n'authentifie pas le transfert ; association et récupération restent à concevoir et tester.
- La compatibilité Expo et les stores chiffrés doivent être vérifiés sur appareils.
- La divergence des bornes de registration ID reste ouverte et hors périmètre de ce jalon.
