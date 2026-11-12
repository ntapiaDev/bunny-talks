# Jalon CRYPTO-005 — Évaluation des primitives du coffre

**Statut :** évaluation expérimentale sous Node en revue ; aucun coffre ni choix cryptographique de production n'est validé.

## Objectif et périmètre

Comparer les KDF et AEAD pour un secret aléatoire fort et le futur coffre de récupération, sans implémenter de format définitif, de récupération complète ou d'autorisation d'appareil. L'identité durable partagée et la décision fonctionnelle de récupération sans ancien appareil restent inchangées.

## Résultats

La [proposition de coffre et son évaluation CRYPTO-005](../security/recovery-vault-architecture.md) comparent HKDF et Argon2id, AES-256-GCM et XChaCha20-Poly1305, Noble, libsodium et les API publiques OpenE2EE. Des tests conservés dans `crypto-engine` caractérisent sous Node les exports publics Noble 2.4.0, avec des vecteurs HKDF, AES-GCM et XChaCha20-Poly1305 et une comparaison AES-GCM avec `node:crypto`. Le vecteur XChaCha est issu d'un Internet-Draft CFRG expiré. Noble est déclaré comme dépendance de développement pour ces tests, pas choisi pour la production.

Aucune primitive de coffre publique ni format versionné n'est implémenté : le contrat des versions et des tailles, la normalisation, la stratégie de nonce et les limites d'usage restent à décider et à auditer. Les tests de versions inconnues et de tailles applicatives abusives restent à ajouter après définition du contrat ; les comparaisons libsodium restent à réaliser. Aucun résultat Node ne démontre la compatibilité Expo/Hermes ou la sécurité des clés sur appareil ; les tests ne sont pas un audit.

## Exigences ouvertes

- **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants** avant association ou récupération en production : écriture conditionnelle et reprise, autorisation individuelle, prévention des substitutions et rejeux et tests sur les backends réels.
- Démontrer la source d'entropie et la gestion des nonces sur Node et appareils mobiles, choisir les versions et paramètres avec une revue de sécurité, tester la séparation des usages et la migration.
- Définir une ancre fiable de fraîcheur : après perte de tous les appareils, un serveur malveillant peut présenter un ancien coffre valide en l'absence de référence indépendante.
- Évaluer le coût Argon2id et les limites de mémoire et de temps constant JavaScript ; vérifier les bindings natifs et la conservation des secrets sur iOS et Android.

## Suite

Soumettre les résultats à revue avant de choisir une bibliothèque et de définir le contrat minimal des primitives et du format. Ne pas engager CRYPTO-006 sans validation.
