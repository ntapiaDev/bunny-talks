# CRYPTO-013 — Charge candidate du coffre de récupération V1

**Statut : format et API expérimentaux pour revue.** Cette charge n'est pas un protocole de restauration, n'est pas approuvée pour la production et peut évoluer après revue. Les limites et la représentation des secrets d'archive sont des choix de test, pas une décision sur la hiérarchie réelle des archives.

**Actualisation du 13 novembre 2026 :** cette charge demeure un profil expérimental lié aux deux paires d'identité étudiées. La cible du coffre possède désormais une clé maître indépendante et deux enveloppes, par mot de passe et par clé de récupération ; aucun pont complet entre ce format, le SDK et l'archive n'est démontré. Voir [l'architecture cible](recovery-vault-architecture.md).

Les API de ce format sont exposées uniquement par `@bunny-talks/crypto-backup/experimental`. Les contrôles de longueur, de version, d'ordre et de copie peuvent guider une conception future, mais les champs, la limite de 64 et le sens des secrets d'archive restent des hypothèses expérimentales, pas un contrat retenu.

## Schéma binaire candidat

Tous les entiers multioctets sont non signés et en ordre réseau (big endian). Les octets sont opaques ; aucun encodage texte, alignement ou padding n'est admis. Les offsets commencent à zéro.

| Offset | Longueur    | Contenu                                                                                   |
| ------ | ----------- | ----------------------------------------------------------------------------------------- |
| 0      | 8           | Identifiant ASCII `BTRPAYLD`                                                              |
| 8      | 1           | Version du format : `1`                                                                   |
| 9      | 1           | Usage candidat : `1` pour récupération d'identité et d'archive                            |
| 10     | 1           | Profil candidat : `1`, identité X25519 et Ed25519, secrets d'archive opaques de 32 octets |
| 11     | 1           | Nombre d'entrées d'archive : de 0 à 64                                                    |
| 12     | 32          | Clé publique d'identité X25519                                                            |
| 44     | 32          | Clé privée d'identité X25519                                                              |
| 76     | 32          | Clé publique d'identité Ed25519                                                           |
| 108    | 32          | Clé privée d'identité Ed25519                                                             |
| 140    | 36 × nombre | Entrées d'archive : version sur 4 octets, puis secret opaque de 32 octets                 |

Les versions d'archive vont de 1 à 4 294 967 295 et sont strictement croissantes, sans doublon. La longueur exacte est `140 + 36 × nombre`, soit 140 à 2 444 octets, sous la limite de 65 536 octets de charge du coffre direct V1. Un compteur nul ne laisse suivre aucune entrée : il permet de créer un coffre avant toute archive, sans générer de clé artificielle. Il ne prouve pas que les clés nécessaires à un historique existant ont été récupérées. Il n'y a ni champ optionnel ni octet supplémentaire : une longueur, un compteur ou un ordre incohérent est rejeté. Un identifiant, une version, un usage ou un profil inconnu est rejeté comme non pris en charge. Une future version ne doit pas être interprétée comme V1 ; elle exigera son propre décodeur et une décision de migration. Ces limites sont candidates, pas un inventaire validé de toutes les clés historiques.

Le profil contient **deux paires de clés brutes**, pas un objet ou un store SDK sérialisé. OpenE2EE 14.4.0 expose une identité composée d'une paire DH, d'une paire de signature et d'un registration ID ; l'évaluation existante vérifie la cohérence des paires X25519 et Ed25519 de 32 octets. Le format sépare ces paires de l'identifiant d'enregistrement propre à l'appareil. Aucune conversion de ce format vers le SDK ni portabilité entre appareils n'est démontrée ici. La validation structurelle accepte toutes les valeurs binaires de 32 octets : elle ne vérifie ni la cohérence d'une paire publique/privée, ni la qualité, l'origine ou l'usage de la clé. Une future couche `crypto-engine` devra effectuer les contrôles et les conversions appropriés sans interpréter une charge structurellement valide comme une identité utilisable.

Chaque entrée d'archive est un **emplacement candidat** pour un secret de version, et non une hiérarchie d'archive définie : son algorithme, sa génération, son rôle, sa relation avec les archives, la sélection des versions nécessaires et la rotation restent à concevoir. Le nombre maximal ne garantit pas la conservation de toutes les versions nécessaires. Aucune archive n'est chiffrée ou restaurée ici. Les sessions de messagerie et états de ratchet, préclés, registration IDs, jetons, clés SQLCipher et autres secrets locaux d'appareil sont exclus. Un nouvel appareil devra disposer de ses propres données de session, préclés, registration ID et clés locales selon le protocole validé.

## API et frontières

`serializeRecoveryPayloadV1` prend des composants explicites et retourne les octets ou une erreur typée ; `decodeRecoveryPayloadV1` valide et retourne des tableaux indépendants ou une erreur typée. Les résultats distinguent charge invalide, format non pris en charge et limite dépassée. Les objets de construction sont stricts : champs supplémentaires, manquants ou accesseurs sont refusés. La charge décodée n'est pas authentifiée par ces fonctions. Le test des octets exacts est un test interne du schéma, pas un vecteur indépendant d'interopérabilité.

Le résultat de sérialisation contient des secrets **en clair** et peut être transmis comme plaintext à `createDirectVaultV1`. Après une ouverture authentifiée avec `openDirectVaultV1`, la validation de la charge reste une étape séparée. Ni le tag du coffre ni la structure de la charge ne prouvent le compte attendu, l'autorisation de récupération, la fraîcheur ou l'absence de rejeu. Il faut comparer le compte à une source fiable indépendante, établir l'autorisation et la fraîcheur, puis valider l'identité et les clés d'archive avant toute activation. L'ordre et les mécanismes restent ouverts.

Le code ne dépend d'aucune API Node pour la représentation, mais le test Node sans `Buffer` ne démontre pas la compatibilité Hermes ou Expo. Le décodeur efface au mieux son instantané temporaire ; les tableaux retournés et ceux fournis ou produits par la sérialisation appartiennent à l'appelant, qui doit limiter leur durée de vie et les effacer au mieux sans les journaliser. JavaScript, les copies internes, le ramasse-miettes et le JIT ne permettent pas de garantir l'effacement de tous les secrets. Les entrées ne doivent pas être modifiées simultanément pendant une opération, notamment depuis une mémoire partagée.

Avant toute restauration réelle : spécifier et tester la hiérarchie et les versions d'archive, les formats et conversions du SDK, la validation des paires, les contrôles d'autorisation et de fraîcheur, les transactions, la reprise après panne, les appareils réels et la revue de sécurité indépendante. L'import actuel dans un store SQLite n'établit pas l'initialisation conditionnelle atomique entre processus. **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants pour la production.** Le secret de récupération est distinct du mot de passe du compte.
