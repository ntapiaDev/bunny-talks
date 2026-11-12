# Jalon CRYPTO-007 — Profil candidat et interopérabilité

**Statut :** recommandation expérimentale pour revue ; aucune composition, bibliothèque ou enveloppe n'est validée pour la production.

## Résultats

L'[évaluation CRYPTO-007](../security/recovery-vault-interop-evaluation.md) recommande d'expérimenter en priorité le chiffrement direct HKDF-SHA-256/XChaCha20-Poly1305 : le besoin documenté ne justifie pas encore la complexité d'une clé de contenu indépendante. La [spécification CRYPTO-006](../security/recovery-vault-specification.md) décrit toujours la composition B historique ; elle ne devient pas le format du scénario direct.

Un vecteur de composition avec données publiques fixes est vérifié par Noble et par des implémentations indépendantes HKDF et libsodium sur l'environnement Node/Linux. Le vecteur caractérise les primitives et leur enchaînement, pas un format canonique de coffre. Aucun contrat public ni code de production n'est ajouté.

## Exigences et décisions ouvertes

- Faire examiner le choix A et les formats existants, puis définir le format, les limites, l'authentification du contexte et des vecteurs complets avant adoption.
- Vérifier les fournisseurs et l'interopérabilité sur Expo Development Builds et Hermes, iOS et Android ; les tests Node ne prouvent pas la compatibilité mobile et ne sont pas un audit.
- Concevoir et tester la fraîcheur, la publication concurrente, la rotation, les interruptions et la récupération après perte de tous les appareils.
- **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants** avant toute association ou récupération en production.

Attendre la revue avant toute décision définitive et ne pas commencer CRYPTO-008 automatiquement.
