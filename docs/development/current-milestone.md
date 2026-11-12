# Jalon CRYPTO-004 — Architecture du coffre de récupération

**Statut :** proposition documentaire en revue ; aucun format, algorithme, fournisseur ou protocole d'autorisation n'est définitivement validé.

## Objectif et décision fonctionnelle

L'ajout principal d'un appareil utilise la connexion au compte, le secret de récupération et le déchiffrement local du coffre, sans ancien appareil. Il restaure l'identité durable, exige l'autorisation individuelle et synchronise l'archive chiffrée. Le QR est facultatif et reporté.

## Livrable et critères de revue

La [proposition de coffre](../security/recovery-vault-architecture.md) décrit les actifs et menaces, la hiérarchie et le format candidats, les secrets inclus et exclus, les alternatives, le parcours, la rotation, les interruptions et les tests nécessaires. Les décisions cryptographiques, la compatibilité mobile et le mécanisme d'autorisation restent à valider. CRYPTO-003 reste une caractérisation expérimentale, pas une association validée.

La proposition compare l'autorisation avant ou après accès au coffre, trois choix de secret et de dérivation, ainsi que les garanties de fraîcheur selon la disponibilité d'un appareil de confiance et le comportement du serveur. Aucun choix technique n'est arrêté. Le changement de mot de passe révoque les sessions des autres appareils tout en conservant celle de l'appareil demandeur ; sa mise en œuvre et la révocation cryptographique distincte restent à concevoir et tester.

## Exigences bloquantes

- **SEC-CRYPTO-002 — ouvert et bloquant :** création conditionnelle ou équivalent, protection des chemins d'écriture, reprise après panne, états partiels et tests sur les backends réels.
- **SEC-CRYPTO-003 — ouvert et bloquant :** autorisation individuelle, authentification et protection contre substitution et rejeu pour tout ajout ou récupération ; les risques propres au transfert QR restent distincts et devront être traités avant tout usage de cette option reportée.
- Coffre : choix audité du format et des composants, protection hors ligne, intégrité du contexte, procédure de reprise et tests Node et mobiles. La détection d'un coffre ancien après perte de tous les appareils exige une ancre de fraîcheur fiable ; sans elle, un serveur malveillant peut présenter une ancienne version valide.
- La possession de l'identité durable ou du secret ne suffit pas à autoriser un appareil. Le modèle de confiance du serveur, la rotation après compromission et la récupération en cas de perte ou d'attaque restent à résoudre.

## Suite

Revue du modèle de menace et des options, puis décision technique explicite avant toute implémentation. Ne pas engager CRYPTO-005 sans validation.
