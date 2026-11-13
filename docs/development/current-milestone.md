# Jalon documentaire post-audit E2EE — 13 novembre 2026

L'audit technique et documentaire constitue une étape d'analyse terminée ; ses conclusions et cette actualisation attendent la revue humaine. La **recommandation B** est de poursuivre provisoirement l'évaluation d'OpenE2EE, sans validation de production. Voir [l'audit consolidé](../architecture/e2ee-transition-audit.md) et [ADR-003](../architecture/decisions/003-open-e2ee-evaluation.md).

Les décisions fonctionnelles actuelles retiennent un mot de passe unique, une clé maître de coffre indépendante et deux enveloppes, ainsi qu'une autorisation individuelle par e-mail avant accès protégé. Le coffre direct existant est expérimental ; aucun parcours complet de récupération ou d'autorisation n'est implémenté. Les bornes de registration ID, la sérialisation de certains états de session, la révocation après compromission, l'archive et la compatibilité mobile restent à caractériser. **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants pour la production.**

La revue humaine doit confirmer les garanties de révocation, la stratégie minimale d'archive et les critères du prochain POC. Le POC envisagé porte sur l'identité commune, les sessions, leur persistance et la révocation avec les API publiques du SDK. **Aucune autorisation actuelle ne permet de commencer ce POC.**

## Travail local préexistant — CRYPTO-014

[CRYPTO-014](../security/archive-key-hierarchy.md) compare quatre modèles d'archive et recommande pour revue une architecture hybride : racines d'archive par compte et par époque, clés de contexte indépendantes, puis clés de contenu aléatoires par objet et version. Les copies personnelles restent distinctes du protocole des espaces partagés et des sessions Signal. Cette recommandation n'est ni approuvée ni implémentée ; aucun format cryptographique, protocole de groupe ou algorithme n'est arrêté dans ce jalon.

Le coffre direct et `RecoveryPayloadV1` peuvent représenter expérimentalement une identité et de 0 à 64 secrets opaques, mais ne définissent ni racines d'archive, ni catalogue de clés, ni complétude ou fraîcheur. Les adaptations, la limite de 64 et une éventuelle migration restent à décider. Une liste vide convient potentiellement à un compte sans archive, sans prouver qu'aucun historique n'existe.

La récupération sans ancien appareil, l'autorisation individuelle, l'import sûr, la protection contre le rejeu et la rotation après compromission restent à concevoir. Une racine compromise peut exposer l'historique de son époque ; une rotation issue de cette racine ne rétablit pas la confidentialité. Un ancien appareil peut conserver le secret de récupération et des copies de clés. La fraîcheur après perte totale ne peut pas être déduite d'un ancien coffre authentique fourni par le seul serveur.

Le moteur direct V1 conserve sa source d'aléa explicite, sans fournisseur inclus ; une source silencieusement défaillante peut produire sel et nonce nuls. Les garanties de mémoire, de compatibilité mobile et de sécurité du parcours complet ne sont pas démontrées. Un changement ordinaire du mot de passe conserve les autres appareils connectés et autorisés ; la révocation est distincte et le secret de récupération indépendant du mot de passe.

La recommandation CRYPTO-014 reste soumise à revue ; elle ne constitue pas une autorisation d'implémentation.
