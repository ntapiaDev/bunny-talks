# Jalon 2 — Composition authentifiée du coffre V1

Statut : implémentation pour revue sous Node, indépendante de la logique métier. Les enveloppes du [jalon 1](key-envelopes-v1.md) sont réutilisées sans modification de leur format ni de leurs profils. Aucun backend, stockage, import OpenE2EE, archivage ou parcours de compte n'est implémenté. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts. Hermes et les plateformes natives restent à qualifier.

## API et garanties

La racine de `@bunny-talks/crypto-backup` expose :

- `createAccountVault(context, password, recoveryKey, plaintext, random): Promise<Uint8Array>` : valide les entrées, génère une seule clé maîtresse de 32 octets, crée les deux enveloppes et les ouvre pour comparer chacune à cette clé, chiffre la charge opaque, authentifie le manifest puis vérifie la publication produite. La charge peut contenir de zéro à 65 536 octets.
- `openAccountVaultWithPassword(bytes, password, context)` et `openAccountVaultWithRecoveryKey(bytes, recoveryKey, context)` : retournent `{ ok: true, plaintext, revisions }` seulement après authentification de l'enveloppe utilisée, du manifest complet et du contenu. L'autre enveloppe n'est pas déchiffrée ; son inclusion authentifiée ne prouve pas qu'elle fonctionne.
- `rewrapAccountVaultPassword(bytes, context, access, newPassword, random): Promise<Uint8Array>` : `access` est `{ type: 'password', password }` ou `{ type: 'recovery', recoveryKey }`. Authentifie intégralement l'ancienne publication, crée et ouvre la nouvelle enveloppe vers la même clé, conserve exactement les chaînes de contenu et de récupération, incrémente la génération et la révision mot de passe, signe puis vérifie le nouvel assemblage. Le chemin mot de passe n'a pas besoin de la clé de récupération.
- `validateAccountVault(bytes, context)` : vérifie uniquement structure et contexte ; succès marqué `structural-only-unauthenticated`. Il ne constitue pas une preuve cryptographique.

Les ouvertures retournent un résultat d'erreur sans secret. Création et réenveloppement lèvent `AccountVaultError`, sans cause ni détail brut. Aucune écriture n'est réalisée et aucun résultat partiel n'est publié. Les buffers de l'appelant ne sont pas modifiés ; les copies sensibles sont prises avant le premier `await`. Les clés et plaintexts temporaires sont effacés au mieux. Les plaintexts retournés appartiennent à l'appelant. Les chaînes de mots de passe ne sont pas effaçables ; JavaScript ne garantit ni effacement complet ni temps constant. Les mutations concurrentes en mémoire partagée sont exclues du contrat.

Le contexte `{ account, vaultId }` est fourni indépendamment du coffre. Il conserve les règles du jalon 1 : compte ASCII imprimable sans espace de 1 à 128 caractères, identifiant de coffre de 16 octets en Base64url canonique. Pour un nouveau coffre, l'appelant utilise `generateVaultId(random)` avant de fixer ce contexte attendu. Une entrée ne permet pas de prouver que l'identifiant a été aléatoire. La clé maîtresse est créée une fois par appel, jamais fournie par le serveur. V1 ne propose pas de rotation de cette clé : aucun identifiant d'époque supplémentaire n'est donc ajouté.

## Format exact

Le document extérieur est un JSON JCS en UTF-8 strict, sans BOM, d'au plus **131 072 octets**. Ses champs obligatoires sont exactement :

| Champ              | Contenu                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `header`           | objet stable décrit ci-dessous                                                         |
| `content`          | chaîne contenant exactement le JSON canonique du contenu chiffré                       |
| `passwordEnvelope` | chaîne contenant exactement les octets UTF-8 canoniques de l'enveloppe mot de passe V1 |
| `recoveryEnvelope` | chaîne contenant exactement les octets UTF-8 canoniques de l'enveloppe récupération V1 |
| `manifest`         | objet `{ version: 1, generation, mac }`                                                |

Le `header` contient exactement `format: "bunny-account-vault"`, `version: 1`, `suite: "hkdf-sha256-xchacha20poly1305-hmac-sha256-v1"`, `account` et `vaultId`.

La chaîne `content` représente exactement `{ version: 1, revision, nonce, ciphertext }` canonisé par JCS : nonce de 24 octets et ciphertext de 16 à 65 552 octets, tag de 16 octets compris. Son document UTF-8 est limité à **88 000 octets**. Le ciphertext est celui de la charge opaque ; `version` est la version de son conteneur, sans interprétation d'une identité ou d'une archive.

Les documents d'enveloppes sont soumis aux validateurs existants et à leur limite de 2 048 octets. Les comptes et identifiants de coffre des deux enveloppes doivent correspondre au contexte extérieur attendu, y compris lorsque l'autre voie est utilisée.

Le `mac` est un HMAC-SHA-256 de 32 octets. Toutes les données binaires utilisent Base64url sans padding ni bits de remplissage non nuls. La couche extérieure et le contenu limitent la profondeur à deux objets, sans tableaux ; champs inconnus, manquants, dupliqués après décodage des échappements et représentations non canoniques sont refusés. Les objets d'enveloppes conservent leurs propres règles. Les profils, paramètres KDF et suites ne peuvent pas être choisis arbitrairement par une entrée.

Les chaînes de documents permettent de conserver et d'authentifier leurs octets canoniques exacts. Le coût d'échappement JSON est borné par les limites du document extérieur. Le parseur reçoit une chaîne entière et peut allouer les tokens avant les callbacks ; les bornes en octets sont appliquées avant décodage.

## Dérivation et authentification exactes

Les fonctions HKDF ci-dessous appliquent extract puis expand avec SHA-256, sortie de 32 octets. Leur entrée est la clé maîtresse aléatoire, leur sel public est **le décodage des 16 octets de `vaultId`** et leur `info` est respectivement :

- `UTF8("bunny-talks/account-vault/v1/content-key")` ;
- `UTF8("bunny-talks/account-vault/v1/manifest-key")`.

Ces domaines sont distincts de ceux des deux enveloppes. Les enveloppes protègent directement la clé maîtresse ; le contenu et le manifest utilisent exclusivement leurs sous-clés dédiées. Les primitives sont celles de Noble 2.4.0 déjà installé ; aucune primitive maison ni dépendance supplémentaire.

Pour chiffrer le contenu, XChaCha20-Poly1305 utilise un nonce frais de 24 octets issu du CSPRNG explicite. L'AAD est exactement :

`UTF8("bunny-talks/account-vault/v1/content\n" + JCS({ header, content: { version, revision, nonce } }))`.

Le ciphertext lui-même est exclu de cette AAD, mais est authentifié par l'AEAD et par le manifest. La génération et les enveloppes sont exclues de l'AAD pour permettre leur évolution sans rechiffrer le contenu.

Pour le manifest, construire `body` avec les mêmes cinq propriétés extérieures, mais `body.manifest` contient uniquement `{ version, generation }`. L'entrée HMAC est exactement :

`UTF8("bunny-talks/account-vault/v1/manifest\n" + JCS(body))`.

`body.content`, `body.passwordEnvelope` et `body.recoveryEnvelope` sont les chaînes exactes validées, pas des objets réinterprétés ni des références serveur. Le HMAC lie donc contexte, contenu chiffré, deux enveloppes, versions et génération ; il n'inclut jamais sa propre valeur. La comparaison des MAC utilise l'API publique `equalBytes` de Noble, sans promettre une garantie de temps constant du runtime JavaScript.

L'ouverture vérifie structure, limites, versions, contexte et paramètres des deux enveloppes avant Argon2id. Après ouverture de la voie demandée, elle vérifie d'abord le HMAC puis l'AEAD du contenu. Aucun plaintext n'est rendu sur échec de l'une de ces étapes.

## Versions, révisions et génération

Tous les compteurs sont des entiers sûrs positifs, jusqu'à 9 007 199 254 740 991. Les versions de format, contenu et manifest sont exactement 1. Les enveloppes conservent leur version indépendante.

Création : génération et trois révisions à 1. Réenveloppement : génération et révision mot de passe augmentées exactement de 1 ; révisions de contenu et récupération inchangées. Toute révision supérieure à la génération est refusée, de même que tout débordement. L'égalité des compteurs n'est pas exigée : ils représentent des cycles de vie distincts. Aucune API de modification du contenu ou de rotation de récupération n'est introduite ici.

Les ouvertures renvoient les quatre compteurs dans `revisions`. Une future couche de publication devra conserver les octets lus et utiliser une révision transactionnelle de backend pour ses écritures conditionnelles. Ce numéro de backend ne sera ni la génération cryptographique ni une ancre indépendante de fraîcheur. L'API actuelle retourne seulement une nouvelle publication complète en mémoire : elle n'établit aucune atomicité ou exclusivité de stockage.

## Erreurs et limites de confiance

Codes : `INVALID_VAULT`, les codes du jalon 1 (`INVALID_INPUT`, `INVALID_ENVELOPE`, `UNSUPPORTED_FORMAT`, `LIMIT_EXCEEDED`, `CONTEXT_MISMATCH`, `AUTHENTICATION_FAILED`, `CRYPTO_UNAVAILABLE`). Un mauvais moyen d'accès, un MAC invalide et un tag invalide sont harmonisés en `AUTHENTICATION_FAILED`. Les échecs de structure peuvent précéder cette catégorie. Les erreurs du fournisseur sont assainies. Aucun log n'est produit.

Le CSPRNG doit réellement remplir les buffers et ne plus les modifier après résolution. Aucun repli prévisible n'existe ; un fournisseur silencieusement défaillant reste une limite. La qualité de l'aléa, l'absence de collisions et la sécurité du runtime ne se prouvent pas par un aller-retour réussi.

Une publication ancienne complète reste authentique et peut être ouverte avec l'ancien mot de passe. Mélanger ses enveloppes avec une nouvelle publication invalide le MAC, mais rejouer l'ensemble n'est pas détectable sans référence fiable indépendante. Une génération supérieure déclarée par un serveur ne prouve pas la fraîcheur ; deux publications concurrentes peuvent aussi avoir la même génération.

Réenvelopper conserve la même clé maîtresse : une ancienne enveloppe volée peut toujours donner accès à cette clé. Cela ne révoque pas des secrets compromis. Une rotation et une réponse à incident sont des travaux distincts. Le détenteur de la clé maîtresse peut signer un manifest ; ce MAC ne prouve ni l'auteur individuel ni l'autorisation d'un appareil.

À la création, les deux enveloppes sont réellement ouvertes et comparées à la même clé. Lors d'une ouverture ordinaire ou d'un réenveloppement par mot de passe, l'enveloppe récupération est authentifiée comme partie de la publication mais sa capacité à restituer la clé n'est pas retestée. Un producteur possédant la clé maîtresse pourrait signer une enveloppe alternative inopérante ; le test dédié montre cette distinction. Aucun résultat d'ouverture n'annonce la validité de la voie non exercée.

## Validation et preuves

`account-vault.test.ts` couvre le vecteur complet, les deux ouvertures, les deux moyens de réenveloppement, la conservation exacte des chaînes, les mauvais secrets, substitutions et mélanges, compteurs et versions, manifest, nonce/ciphertext/tag, documents incomplets, limites, interruptions et buffers de l'appelant. Une altération du contenu avec un manifest recalculé à l'aide de la clé publique de fixture échoue toujours à l'AEAD. Les tests de frontières instrumentent Argon2id et confirment l'absence de dérivation sur les assemblages structurellement invalides.

Le vecteur public `tests/fixtures/account-vault-v1.json` est produit indépendamment : Argon2id natif Node 24, HKDF via Python cryptography, HMAC via Python hmac/hashlib, XChaCha via libsodium système. Il contient les sous-clés, AAD et entrée MAC de test et les octets exacts de publication. `python3 packages/crypto/backup/tests/fixtures/verify-account-vault.py` en vérifie la reproduction ; `--write` régénère la fixture publique. Aucun secret réel n'est traité par ce script. Vitest compare la création complète aux octets indépendants puis ouvre la publication. Ce script optionnel n'ajoute aucune dépendance de production et n'est pas lancé implicitement par Vitest.

Les tests fonctionnels Node et ces vecteurs ne constituent pas un audit indépendant. Hermes, mobile, stockage et publication durable ne sont pas qualifiés par ce jalon ; aucun parcours de récupération de compte n'est déclaré fonctionnel.

Vérifications du jalon exécutées avec succès sous Node : `pnpm test` (y compris les tests historiques), `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm -r --if-present build`, `git diff --check`, imports des exports compilés et vérification indépendante des fixtures de composition et de récupération. Les onze tests ciblés de composition et de frontières KDF passent. Aucun test natif mobile ni scénario de stockage durable n’a été exécuté dans ce jalon.
