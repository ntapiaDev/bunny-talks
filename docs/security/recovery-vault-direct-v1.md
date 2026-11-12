# CRYPTO-008 — Spécification candidate du coffre direct V1

**Statut : format et moteur expérimentaux pour revue ; aucun protocole complet de coffre n'est validé pour la production.** Le format ci-dessous remplace, pour les prochaines expériences, l'enveloppe à deux clés de CRYPTO-006, conservée comme comparaison. Les limites, identifiants, contrats et octets restent candidats ; les modifier exige de régénérer les vecteurs. Les tests des primitives ne valident pas le protocole complet.

L'[investigation CRYPTO-009](recovery-vault-technical-prerequisites.md) précise les candidats de parsing et d'aléa ainsi que les chemins de débogage à repli prévisible à exclure.

**Actualisation CRYPTO-012 :** `@bunny-talks/crypto-backup` implémente une création et une ouverture expérimentales ainsi que la validation structurelle. Ces API ne sont pas approuvées pour la production. Voir le [jalon courant](../development/current-milestone.md) pour les limites et vérifications.

## Frontières

Le coffre générique protège des octets opaques et ne connaît pas OpenE2EE. Une couche Bunny Talks distincte construira et validera la charge d'identité et les clés d'archive. Un orchestrateur séparé gérera compte, stockage, autorisation, activation, récupération et reprise. Le package expérimental `crypto-backup` est indépendant d'OpenE2EE ; ses dépendances restent à approuver pour la production. La possession du secret ou le déchiffrement ne prouvent pas l'autorisation individuelle.

## Profil et format candidats

Le secret de récupération est exactement 32 octets issus d'un CSPRNG fiable, avec au moins 128 bits d'entropie effective ; une longueur correcte seule ne prouve pas l'entropie. À chaque création, le CSPRNG produit un sel de 16 octets et un nonce de 24 octets, de façon indépendante. HKDF-SHA-256 dérive une clé AEAD de 32 octets ; XChaCha20-Poly1305 produit un ciphertext suivi d'un tag de 16 octets. Ne jamais réutiliser une paire clé/nonce. Chaque nouvelle enveloppe, y compris rotation du secret ou contenu, obtient de nouveaux sel et nonce ; leurs collisions restent possibles et une politique d'utilisation doit être arrêtée avant production.

La racine est exactement `{ "ciphertext": ..., "header": ... }`. Les champs suivants sont tous obligatoires ; refuser champs inconnus ou dupliqués, y compris ceux de la proposition à deux clés (`wrappedKey`, `wrapNonce`, `contentNonce`).

| Objet    | Champ        | Valeur candidate                                                                            |
| -------- | ------------ | ------------------------------------------------------------------------------------------- |
| Racine   | `ciphertext` | Base64url sans padding du ciphertext et de son tag concaténés ; 16 à 65 552 octets décodés. |
| `header` | `format`     | Chaîne exacte `bunny-recovery-vault-direct`.                                                |
| `header` | `version`    | Entier JSON `1`.                                                                            |
| `header` | `profile`    | Chaîne exacte `hkdf-sha256-xchacha20poly1305-v1`.                                           |
| `header` | `account`    | Base64url canonique de 16 octets opaques ; origine fiable à définir hors de l'enveloppe.    |
| `header` | `purpose`    | Chaîne exacte `identity-recovery` ; aucun autre usage n'est implicitement autorisé par V1.  |
| `header` | `generation` | Entier sûr de 1 à 9 007 199 254 740 991 inclus.                                             |
| `header` | `salt`       | Base64url canonique de 16 octets.                                                           |
| `header` | `nonce`      | Base64url canonique de 24 octets.                                                           |

La représentation sur le fil est UTF-8 strict, sans BOM, de l'objet complet canonisé par [JCS, RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html). Les octets binaires utilisent [Base64url RFC 4648 §5](https://www.rfc-editor.org/rfc/rfc4648.html#section-5), sans padding ; la conversion inverse suivie d'un réencodage doit rendre exactement la chaîne reçue, y compris les bits de remplissage canoniques. Les valeurs et noms textuels de V1 sont ASCII. JCS ne normalise pas Unicode ; rejeter UTF-8 invalide et substituts isolés, puis les valeurs hors schéma, sans normalisation implicite. Les nombres doivent avoir la représentation canonique JCS ; refuser toute notation non canonique sur le fil.

Pour tout en-tête `header` valide, les opérations exactes proposées sont :

1. `info = UTF8("bunny-talks/recovery-vault-direct/v1/key")` ; `key = HKDF-SHA-256(secret, salt, info, 32)`.
2. `aad = UTF8("bunny-talks/recovery-vault-direct/v1/aad\n") || UTF8(JCS(header))`.
3. `ciphertext = XChaCha20-Poly1305-Encrypt(key, nonce, plaintext, aad)` ; sérialiser la racine complète selon JCS.

Les deux préfixes constants, distincts et versionnés, séparent domaine de dérivation et domaine AEAD ; ils ne sont pas choisis par le serveur. L'en-tête complet est associé au ciphertext et ne devient authentique qu'après vérification du tag. L'identifiant de compte et l'usage attendus doivent venir d'un contexte fiable authentifié **indépendant de l'enveloppe** ; leur comparaison avant déchiffrement ne prouve pas à elle seule leur authenticité. L'AAD ne protège ni fraîcheur, ni autorisation, ni disponibilité.

## Validation et contrats envisagés

Avant toute dérivation, limiter l'enveloppe brute à **131 072 octets** et la charge à **65 536 octets** ; ce sont des plafonds candidats à justifier par l'inventaire réel de l'identité et de l'archive, l'expansion Base64 et les appareils cibles. Contrôler les tailles encodées avant allocation, la profondeur maximale de deux objets, le nombre exact de champs et la longueur de chaque chaîne. Refuser types invalides, champs absents ou supplémentaires, versions et profils non pris en charge, secret d'une longueur différente de 32 octets et ciphertext inférieur au tag. Aucune dérivation ne doit précéder ces contrôles.

Un parseur doit détecter les noms dupliqués après décodage des échappements avant leur perte, y compris `account` et `acc\u006funt`. `JSON.parse` seul ne conserve pas cette information. Contrôler l'UTF-8, les doublons et les bornes, puis comparer les octets d'entrée à la sortie JCS exacte et refuser toute représentation non canonique. La combinaison expérimentale de CRYPTO-011 applique ces contrôles sous Node ; sa sûreté face à toutes les entrées hostiles et sa portabilité mobile ne sont pas démontrées.

Contrats conceptuels (l'API expérimentale effective est décrite dans le jalon courant) :

- `create(secret, plaintext, expectedContext, generation)` : valider les entrées, obtenir sel et nonce du fournisseur CSPRNG, dériver, chiffrer et retourner l'enveloppe canonique. Une absence ou erreur signalée du CSPRNG provoque un échec fermé, sans valeur de secours prévisible ; une défaillance silencieuse n'est pas détectable par ce contrat. Pas d'injection de hasard déterministe dans l'API de production.
- `validateEnvelope(bytes, expectedContext)` : effectuer uniquement les contrôles de structure, format, tailles et contexte attendu ; retourner une représentation opaque liée à une copie immuable. Ce résultat n'authentifie pas l'enveloppe.
- `open(secret, validatedEnvelope)` : vérifier la longueur du secret et authentifier l'en-tête et le ciphertext ; ne retourner le plaintext complet qu'après succès. Aucune donnée partielle en cas d'échec ; l'appelant doit ensuite valider la charge métier avant toute écriture.

Distinguer secret de format invalide, enveloppe malformée ou trop grande, format/version/profil non pris en charge, contexte inattendu, échec d'authentification, fournisseur indisponible et erreur interne. Un secret incorrect et une altération AEAD ne sont pas distinguables : même catégorie d'authentification. Les erreurs et logs n'exposent ni secret, ni clé, ni plaintext, ni enveloppe complète, ni exception brute du fournisseur. Maîtriser les détails exposés à un tiers pour éviter un oracle. Effacer au mieux les copies sensibles mutables sans altérer les buffers de l'appelant ; ni effacement complet ni temps constant ne sont garantis en JavaScript.

La génération est une métadonnée authentifiée, pas une garantie de fraîcheur. La révision transactionnelle du stockage et une éventuelle ancre indépendante sont distinctes ; aucune ne suffit seule face à un serveur malveillant. Une rotation doit conserver l'ancienne enveloppe jusqu'à publication durable et réconciliation ; une ancienne copie reste ouvrable avec l'ancien secret. La conception transactionnelle, la reprise et la récupération sans appareil restent ouvertes.

## Vecteur, état des tests et limites

`recovery-direct-v1-vector.json` contient uniquement des données publiques fixes : secret de test, sel, nonce, `info`, en-tête canonique, AAD, clé, plaintext, ciphertext/tag et enveloppe canonique. Le résultat cryptographique a été produit avec Python `cryptography` et libsodium, puis comparé avec Noble ; le JSON de ce vecteur ASCII simple est sérialisé indépendamment par Python et Node. Cela ne valide ni un parseur JCS général ni la sûreté de la composition. Le vérificateur indépendant peut être relancé :

```sh
python3 packages/crypto/engine/tests/fixtures/verify-recovery-direct-vector.py packages/crypto/engine/tests/fixtures/recovery-direct-v1-vector.json
```

Les tests Vitest comparent les octets du vecteur, ouvrent le ciphertext et vérifient le rejet pour une génération ou un sel modifié. Les tests de primitives CRYPTO-005/007 couvrent déjà mauvais secret, AAD, nonce, ciphertext, tag et séparation de contextes dans leurs scénarios respectifs ; ils précèdent les tests de l'API expérimentale ajoutée dans CRYPTO-012.

Pour une validation complète, poursuivre les tests sur les API, notamment : création et ouverture, secret incorrect, contexte de compte/usage différent, modification de chaque champ d'en-tête, sel, nonce, ciphertext et tag ; champs manquants ou inconnus, doublons et échappements équivalents, UTF-8 et Base64url non canoniques, JSON non canonique, limites exactes et hors limites, versions et profils inconnus, échec CSPRNG, aucune dérivation sur entrée invalide, aucune sortie partielle et séparation des usages. Vérifier la composition complète et la sérialisation par des implémentations indépendantes dans les deux sens ; ne pas assimiler le vecteur fixe à une preuve générale d'interopérabilité.

## Alternatives et préalables

[JWE](https://www.rfc-editor.org/rfc/rfc7516.html) offre des modes directs ou une clé de contenu enveloppée ; [age](https://c2sp.org/age@v1.1.0) utilise une clé de fichier. Les compatibilités exactes avec ce profil et Expo restent à étudier. Le format direct proposé simplifie le scénario à un seul secret mais est une composition propre à examiner, pas un format standard existant.

Avant implémentation d'une API de production : revue de sécurité indépendante de la composition et du format, choix et licence des dépendances directes, parseur/JCS portables, source CSPRNG sur Hermes, tests sur Expo Development Builds iOS/Android, bornes justifiées, publication et fraîcheur fiables, modèle des secrets d'archive et reprise. Les expériences Node ne démontrent ni compatibilité mobile ni audit. **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouvertes et bloquantes** avant toute association ou récupération en production.

## Implémentation expérimentale CRYPTO-012

`createDirectVaultV1(plaintext, secret, { account, generation }, random)` retourne des octets JCS. `openDirectVaultV1(envelope, secret)` valide la structure avant dérivation et retourne soit les octets authentifiés, soit une erreur structurelle ou `AUTHENTICATION_FAILED`. Un secret de taille incorrecte et les arguments de création invalides lèvent une exception ; les erreurs internes inattendues se propagent. La validation ne compare pas le compte à un contexte fiable : l'appelant doit effectuer cette comparaison et vérifier l'usage après authentification avant toute utilisation. Pour un service distant, ne pas exposer ces distinctions sans analyse des oracles.

Ces étapes sont distinctes : la validation structurelle ne prouve pas l'authenticité ; la vérification du tag authentifie les octets de l'en-tête et du contenu sous le secret fourni ; la correspondance du compte doit être vérifiée par rapport à une source fiable indépendante ; l'autorisation de récupération exige une décision distincte. La génération authentifiée ne prouve pas la fraîcheur et aucun contrôle de rejeu ou de retour arrière n'est implémenté. Les erreurs inattendues, y compris celles du fournisseur d'aléa, sont propagées telles quelles : l'appelant doit éviter d'en divulguer le contenu dans les journaux ou à un tiers.

La source `CryptographicRandomSource` est obligatoire et doit remplir intégralement chaque tampon avant de résoudre sa promesse, sans le modifier ensuite, avec un CSPRNG vérifié produisant sel et nonce frais et indépendants pour chaque création. Un test caractérise une source défectueuse qui retourne normalement sans écrire : les tampons initialisés à zéro produisent une enveloppe valide avec sel et nonce entièrement nuls ; deux créations identiques réutilisent alors la même paire clé/nonce. C'est une violation grave du contrat, non détectée par l'interface. Un contrôle de longueur, un rejet des valeurs nulles ou un test statistique ne prouvent ni remplissage complet ni entropie : une valeur nulle reste possible avec une source correcte, et une source défaillante peut produire d'autres valeurs prévisibles. Une source déterministe n'est acceptable que pour les tests. Le contrat documenté réduit les ambiguïtés d'intégration sans garantir la qualité du fournisseur ; changer la signature ne prouverait pas davantage l'entropie. La prévention des collisions et réutilisations exige une politique et un fournisseur vérifiés sur chaque plateforme avant production. Aucune source n'est fournie.

Les dépendances directes d'exécution `@noble/ciphers` et `@noble/hashes` 2.4.0 réutilisent les primitives évaluées ; aucune approbation de production ou compatibilité Hermes n'en découle. Noble vérifie le tag avant de déchiffrer ; sa version installée signale un tag invalide par `Error('invalid tag')`, sans type public dédié. La conversion de ce message précis est fragile lors d'une mise à jour et doit être revue à chaque changement de version ; toute autre exception est propagée. La clé dérivée et les copies locales du secret et du plaintext sont écrasées au mieux, sans garantie d'effacement JavaScript ni de temps constant. Le résultat ne protège ni contre le rejeu ni contre le retour à une ancienne génération. Les mesures de résistance aux allocations sous Hermes, la revue indépendante, l'interopérabilité générale, l'autorisation et la fraîcheur restent à réaliser. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent bloquants pour la production.
