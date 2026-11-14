# Jalon 1 — Enveloppes de clé maîtresse V1

Statut : implémentation réutilisable pour revue, profil candidat expérimental. Ce jalon ne compose pas le coffre et ne réalise aucune récupération de compte. OpenE2EE, Expo, le backend et SQLCipher ne sont pas des dépendances de cette API. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

## API et propriété des secrets

La racine de `@bunny-talks/crypto-backup` expose :

- `generateMasterKey(random)` et `generateRecoveryKey(random)` : 32 octets indépendants par appel au fournisseur.
- `generateVaultId(random)` : 16 octets aléatoires encodés en Base64url canonique.
- `derivePasswordWrappingKey(password, salt)` et `deriveRecoveryWrappingKey(recoveryKey, salt)` : clés d'enveloppement de 32 octets. Les sels doivent contenir exactement 16 octets.
- `createPasswordKeyEnvelope(masterKey, password, metadata, random)` et `createRecoveryKeyEnvelope(masterKey, recoveryKey, metadata, random)` : octets canoniques d'une enveloppe. `metadata` contient `account`, `vaultId` et `revision`.
- `openPasswordKeyEnvelope(bytes, password, expectedContext)` et `openRecoveryKeyEnvelope(bytes, recoveryKey, expectedContext)` : résultat `{ ok: true, masterKey }` ou `{ ok: false, code }`. Le contexte attendu contient compte et coffre, fournis indépendamment du document reçu.
- `validatePasswordKeyEnvelope(bytes)` et `validateRecoveryKeyEnvelope(bytes)` : validation structurelle seule. Le résultat figé ne prouve aucune authenticité. Les ouvertures revalident toujours leurs octets d'entrée.

Les fonctions de création et dérivation lèvent `KeyEnvelopeError` avec un code sans détail du fournisseur ; les ouvertures et validations retournent des erreurs typées. Les copies des secrets de l'appelant sont prises avant le premier `await`, puis effacées au mieux en `finally`. Les secrets retournés appartiennent à l'appelant ; celui-ci doit limiter leur durée de vie et les effacer lorsqu'ils deviennent inutiles. Aucun log n'est émis. Les chaînes de mots de passe, les copies du moteur, le JIT et le ramasse-miettes empêchent tout effacement garanti et toute promesse générale de temps constant.

Le contrat `CryptographicRandomSource` exige de remplir complètement le buffer avec un CSPRNG vérifié, de terminer l'écriture avant résolution et de ne plus le modifier ensuite. L'absence, l'erreur ou le détachement du buffer échouent sans repli. Un fournisseur silencieusement défaillant reste indétectable par ce contrat : aucune vérification statistique ne prouve son entropie. Les sources déterministes des tests ne sont pas des fournisseurs de production. Les entrées ne doivent pas subir de mutations concurrentes depuis une mémoire partagée.

## Représentation et contexte

Les deux formats ont exactement deux propriétés racines : `header` et `ciphertext`. Le document complet est UTF-8 strict, sans BOM, canonisé selon JCS (RFC 8785). Les octets sont représentés en Base64url sans padding, avec rejet des bits de remplissage non nuls. Maximum : **2 048 octets**, vérifiés avant décodage ; profondeur maximale : deux objets ; tableaux, propriétés inconnues, manquantes ou dupliquées (après décodage des échappements), commentaires et représentations non canoniques sont refusés.

Le compte est une chaîne opaque de **1 à 128 caractères ASCII imprimables sans espace**, codes U+0021 à U+007E. Elle n'est ni nettoyée, ni interprétée, ni normalisée. Le contrat n'impose pas d'UUID ni l'ancien compte de 16 octets. L'attribution et la correspondance avec les identifiants métier relèvent de l'intégration future. Le coffre est un identifiant de 16 octets aléatoires en Base64url canonique. Ces références ne sont pas des secrets. Le contexte reçu est comparé au contexte attendu avant dérivation ; une infrastructure qui contrôle aussi cette source attendue reste une limite de confiance.

Le mot de passe est une chaîne Unicode bien formée, non vide, de **1 à 1 024 octets UTF-8**. Les substituts isolés sont refusés. Aucun trim, NFC, NFD ou autre normalisation implicite n'est effectué : les formes composées et décomposées sont distinctes. Cette borne technique n'est pas une politique de robustesse des mots de passe et ne doit pas être confondue avec le contrat futur d'authentification.

## Champs exacts

Tous les champs ci-dessous sont obligatoires ; les noms anglais sont les noms sur le fil.

| Champ de `header`                                  | Mot de passe                                          | Récupération                                        |
| -------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| `format`                                           | `bunny-password-key-envelope`                         | `bunny-recovery-key-envelope`                       |
| `version`                                          | entier `1`                                            | entier `1`                                          |
| `access`                                           | `password`                                            | `recovery`                                          |
| `account`, `vaultId`                               | contexte défini ci-dessus                             | même contrat                                        |
| `revision`                                         | entier sûr de 1 à 9 007 199 254 740 991               | même contrat                                        |
| `profile`                                          | `argon2id-64m-t3-p4-hkdf-sha256-xchacha20poly1305-v1` | `hkdf-sha256-xchacha20poly1305-v1`                  |
| `domain`                                           | `bunny-talks/key-envelope/password/v1/wrapping-key`   | `bunny-talks/key-envelope/recovery/v1/wrapping-key` |
| `salt`                                             | 16 octets aléatoires                                  | 16 octets aléatoires                                |
| `nonce`                                            | 24 octets aléatoires indépendants                     | 24 octets aléatoires indépendants                   |
| `outputBytes`                                      | entier `32`                                           | entier `32`                                         |
| `memoryKiB`, `passes`, `parallelism`, `kdfVersion` | exactement `65536`, `3`, `4`, `19`                    | champs interdits                                    |

`ciphertext` contient exactement **48 octets** : 32 octets de clé maîtresse chiffrée suivis du tag de 16 octets. L'enveloppe ne contient aucune autre charge métier.

## Opérations cryptographiques

Le fournisseur actuel est Noble 2.4.0, déjà installé directement ; aucun ajout de dépendance. Les primitives ne sont pas réimplémentées.

Pour le mot de passe, calculer Argon2id version 0x13 sur ses octets UTF-8, avec 65 536 Kio, trois passes, quatre voies, sel de 16 octets et sortie de 32 octets. Puis dériver la clé AEAD par HKDF-SHA-256 avec cette sortie, le même sel public, `info = UTF8(header.domain)` et une sortie de 32 octets. Pour la récupération, appliquer directement HKDF-SHA-256 à la clé aléatoire de 32 octets avec son sel et son domaine distinct. HKDF n'ajoute aucune entropie et ne remplace pas Argon2id pour un mot de passe.

XChaCha20-Poly1305 utilise la clé dérivée et le nonce déclaré. Ses données associées sont exactement :

`UTF8("bunny-talks/key-envelope/" + access + "/v1/aad\n" + JCS(header))`.

Les domaines sont des constantes de l'implémentation, vérifiées dans le document ; ils ne sont pas choisis librement par le serveur. Tous les champs d'en-tête sont authentifiés. Une modification valide structurellement du sel, nonce ou de la révision fait échouer l'authentification. Chaque création requiert de nouveaux sel et nonce ; ne jamais réutiliser une paire clé/nonce. Une collision aléatoire reste théoriquement possible.

Seuls les profils exacts ci-dessus sont autorisés. Les paramètres de documents non fiables sont vérifiés avant toute dérivation coûteuse ; aucun repli n'existe. Le budget mémoire Noble `maxmem` est fixé à 64 Mio pour son grand tableau Argon2 ; ce n'est pas une borne sur toute la mémoire du processus. Les allocations annexes et copies s'y ajoutent. L'API asynchrone cède périodiquement au scheduler (`asyncTick: 10`), mais ne fournit ni thread natif dédié ni garantie de latence de 10 ms. Le parallélisme Argon2 est un paramètre de l'algorithme, pas une preuve de quatre threads JavaScript.

## Rejets et limites

Les codes sont `INVALID_INPUT`, `INVALID_ENVELOPE`, `UNSUPPORTED_FORMAT`, `LIMIT_EXCEEDED`, `CONTEXT_MISMATCH`, `AUTHENTICATION_FAILED`, `CRYPTO_UNAVAILABLE`. Un mauvais secret et un tag invalide partagent `AUTHENTICATION_FAILED`. Aucun secret partiel n'est retourné. La reconnaissance du message `invalid tag` dépend de Noble 2.4.0 épinglé ; une autre erreur est classée comme indisponibilité cryptographique. La catégorie structurelle peut précéder la détection d'un format incompatible.

La révision est authentifiée mais n'établit aucune fraîcheur. Un ancien document valide reste ouvrable. Les deux enveloppes indépendantes ne prouvent pas encore leur appartenance à une même publication : le manifest authentifié futur devra lier les enveloppes et le contenu. Les créations doivent recevoir la même clé maîtresse ; aucune activation de compte n'est effectuée ici.

La force de la clé de récupération ne compense pas un mot de passe faible. Une copie des enveloppes autorise les essais hors ligne. Une ancienne enveloppe copiée reste déchiffrable avec son ancien secret. L'authentification classique transmet temporairement le mot de passe au serveur sur TLS : un serveur actif peut le capturer. Aucun secret E2EE ne doit lui être transmis en clair.

Hermes, Metro, iOS, Android physique, mémoire, batterie et interruptions restent à qualifier. La qualification Android des sessions OpenE2EE ne qualifie pas ces enveloppes ni Argon2id. Le parseur reçoit une chaîne entière ; les callbacks n'évitent pas l'allocation initiale des tokens, bornée ici par 2 Kio. `canonicalize` 5.0.0 dépend notamment de `String.prototype.isWellFormed`.

## Preuves exécutables

Le test historique Argon2id utilise le vecteur RFC 9106 §5.3 à 32 Kio. Le test des nouvelles dérivations compare aussi le profil exact à 64 Mio avec l'API native `node:crypto.argon2`, puis HKDF natif. Les primitives HKDF et XChaCha conservent leurs vecteurs indépendants existants dans `crypto-engine`.

`tests/fixtures/key-envelope-recovery.json` est une enveloppe publique déterministe complète produite indépendamment avec Python cryptography et libsodium système. `python3 packages/crypto/backup/tests/fixtures/verify-key-envelope.py` vérifie sa régénération exacte ; `--write` régénère le fichier. Ces outils ne sont pas des dépendances de production et ne sont pas requis silencieusement par Vitest. Vitest compare les octets dans les deux sens. Les scénarios couvrent contextes, domaines, altérations, encodages, paramètres interdits avant KDF, erreurs et buffers ; ils ne remplacent pas un audit cryptographique indépendant.
