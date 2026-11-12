# Jalon CRYPTO-008 — Coffre direct V1 candidat

**Statut :** spécification et vecteur expérimental pour revue ; aucune API de coffre n'est implémentée ou validée pour la production.

## Résultat

La [spécification directe V1](../security/recovery-vault-direct-v1.md) définit une proposition d'enveloppe, les domaines HKDF et AEAD, les contrôles préalables et les frontières entre coffre générique, charge d'identité et orchestration. Un vecteur complet public de l'enveloppe candidate est vérifié sous Node et par Python/libsodium. Aucun package, contrat public ou fournisseur de production n'est ajouté.

## Critères et limites

- Faire examiner les choix du format, son parseur canonique et ses limites ; le vecteur ne valide pas une implémentation générale de JCS ni de coffre.
- Définir et tester les vraies API de création, validation et ouverture ; la matrice de rejets et de tailles est détaillée dans la spécification et n'est pas encore couverte au niveau de l'enveloppe.
- Établir le CSPRNG et l'interopérabilité sur Expo Development Builds/Hermes, iOS et Android ; les tests Node ne sont pas une preuve mobile ni un audit.
- Définir publication conditionnelle, fraîcheur, reprise et rotation sans perte ; la génération authentifiée ne suffit pas contre le retour arrière.
- **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouvertes et bloquantes** pour l'association ou la récupération en production.

Le choix du fournisseur de production, du parseur, des limites finales, du stockage et de la source fiable du compte reste ouvert. Attendre la revue avant une API de production ; ne pas commencer CRYPTO-009 automatiquement.
