# Migration de sécurité OpenE2EE 14.4.0 → 14.5.0

## Périmètre et verdict

Jalon du 14 novembre 2026 : migration validée pour poursuivre les expériences Node dans les scénarios testés. La qualification mobile pourra reprendre après revue humaine. Aucune preuve Hermes, Android ou iOS, aucun audit indépendant ni validation globale de production n'en découle.

La dépendance du moteur est épinglée exactement à 14.5.0. L'alias de développement `@bunny-talks/open-e2ee-14-4` désigne le package npm officiel 14.4.0 et conserve la preuve comparative. Aucun autre package résolu n'est actualisé. Les versions partagées restent Noble 2.4.0, post-quantum 0.7.1 et SQLCipher Node via `better-sqlite3-multiple-ciphers` 13.0.3. Environnement : Node 24.22.2, pnpm 10.34.9, Linux dans l'environnement de travail WSL.

## Provenance et comparaison

Les deux archives ont été obtenues du registre npm officiel, séparément du code applicatif, avec scripts désactivés. Les SHA-512 calculés correspondent aux valeurs `dist.integrity` du registre et aux résolutions du lockfile :

- 14.4.0 : `sha512-+ioVRkY6T18+z5ZnvJU+EwlTUZ3H5+uETqUfeR1pRrbnsfUk8zrhz/gPfDRV3LfjfAJSx+gqiBs1yvguSZ25XA==`.
- 14.5.0 : `sha512-qTbcDtjA4Szg/4KYKshn8Cd8UlE+1NSaVj32ZhnUpqIKyGxb8qiqqOWNUnEAgUcfGw53aehDZ2puogY6sXAZ6w==`.

Le registre annonce aussi des signatures et attestations ; leur chaîne de confiance n'a pas été vérifiée cryptographiquement ici. L'égalité d'empreintes établit la correspondance aux archives publiées, pas leur sécurité. Références : [publication](https://github.com/open-e2ee/signal-protocol-js/releases/tag/v14.5.0), `CHANGELOG.md` et déclarations de chacune des versions installées.

Les manifests ont les mêmes chemins exportés et plages de dépendances. Les types publics utilisés par Bunny Talks compilent avec 14.5.0. `types/api.d.ts` précise désormais que le SDK ne délègue pas la confiance des appareils propres à `isTrustedIdentity`. Les marques TypeScript des deux installations sont distinctes : les conversions explicites restent confinées au test comparatif, sans modification des contrats de production.

## Correctif : sources et annonces

L'analyse de `internal/session/session-trust.js`, de ses appels dans le gestionnaire et le chiffreur constate une décision commune aux chemins d'établissement, chiffrement et déchiffrement. Un appareil propre est identifié par son user ID ; son identité composite doit correspondre à l'identité locale du même type. Les contacts conservent leur politique de confiance. Aucune importation interne n'est ajoutée au projet.

Avant le commit d'une session légitime, une épingle propre différente est remplacée par l'identité locale via `acceptContactIdentityRotationAndDeleteSessions`. Le code utilise un verrou par utilisateur au sein du processus ; cela ne résout pas l'atomicité de l'import entre écrivains de SEC-CRYPTO-002.

Le chemin `sendGroupKeySyncToLocalOtherDevices` sérialise les clés puis utilise `sendSyncPayloadToLocalOtherDevices`, qui passe par les sessions et leur vérification de confiance. Ce rattachement est vérifié par lecture des sources, sans exercice d'un groupe réel. Le journal annonce aussi le refus des autres synchronisations propres et des comportements différents selon la comparaison des listes par le relay : aucune garantie de tous ces chemins n'est déduite de nos tests individuels.

Les autres corrections annoncées concernent le renouvellement du certificat pour les rejeux sealed sender, les certificats courts, les endorsements de groupes, le refus non réessayable `DEVICE_LINK_REQUIRED` et la négociation descendante du protocole relay. Elles ont été examinées dans le journal ; elles ne font pas l'objet de nouvelles preuves réseau de bout en bout dans ce jalon.

## Preuves adversariales

`own-identity-security.test.ts` utilise A1 et A2 avec une identité durable commune, Bob distinct et une identité attaquante avec ses propres clés privées et préclés réelles. Une surcouche de relay substitue uniquement le bundle demandé pour A2 ; le test vérifie que cette substitution a effectivement été servie. La fixture ne bloque pas la substitution.

- **14.4.0 :** A1 épingle l'identité divergente, établit une session et publie une copie de synchronisation. Le client possédant les secrets attaquants déchiffre réellement cette copie et retrouve le contenu envoyé à Bob.
- **14.5.0 :** A1 n'épingle rien pour cet appareil, ne crée aucune session avec lui et ne publie aucune copie de synchronisation vers lui. L'établissement explicite échoue avec `UntrustedIdentityError`. Un PreKeyMessage hostile produit par 14.4.0 est aussi refusé, sans session ni épingle créées.
- L'identité durable locale reste intacte et la conversation avec Bob continue après l'attaque.

Pour l'épingle périmée, le test 14.5.0 crée d'abord deux sessions divergentes réelles avec les API publiques de 14.4.0 dans le store. L'établissement avec le bundle légitime remplace l'épingle par l'identité locale, supprime l'autre ancienne session propre et rétablit la session avec A2. A2 déchiffre un nouveau message. La session de Bob reste utilisable. Sous 14.4.0, l'établissement légitime est refusé avec `UntrustedIdentityError` et l'épingle divergente reste conservée.

Ce remplacement rétablit la référence locale déjà détenue ; il ne démontre ni changement authentifié d'identité distante ni rotation de compte. La suppression exige de rétablir les autres sessions propres : leur disponibilité immédiate et les courses concurrentes ne sont pas garanties par ce test. Aucun transfert de clé de groupe n'est exécuté ; son absence n'est donc pas revendiquée comme propriété expérimentalement démontrée.

## Migration SQLCipher et anomalies

Le test de redémarrage exécute des processus distincts avec des versions isolées : préparation 14.4.0, fermeture, ouverture 14.5.0. Deux bases chiffrées contiennent des identités différentes, des registration IDs 41 et 42 et une conversation réelle avec réponse. Avant le premier échange après migration, les identités complètes, sessions et préclés signées/Kyber sont comparées aux valeurs conservées avant fermeture ; elles sont identiques. La conversation reprend dans les deux sens.

Les fichiers `sqlite/schema.js` et `sqlite/migrations.js` sont identiques entre les versions. Le journal mentionne un champ facultatif `sealedSenderCertificateExpiresAt`, compatible selon l'éditeur ; nos tests ne produisent pas de corps sealed sender hébergé. Le retour à 14.4.0 n'a pas été qualifié et n'est pas recommandé automatiquement.

Les ouvertures sans clé ou avec une clé modifiée échouent respectivement avec `LOCAL_STORE_KEY_LOST` et `KEY_STORAGE_ERROR`. Une ouverture correcte ultérieure conserve l'état et reprend la conversation. Aucun accès aux tables privées ni désactivation du chiffrement n'est utilisé. Le refus d'un schéma futur, les interruptions au milieu d'une migration et les bases endommagées ne sont pas testés ici.

La fixture conserve temporairement les secrets et snapshots binaires dans un répertoire privé 0700, fichiers 0600, supprimé en fin de test. Ce coffre de test n'est pas une solution de stockage de production. Les assertions et journaux ne doivent pas publier les valeurs privées.

Les tests existants caractérisent toujours la divergence du générateur de registration ID (jusqu'à 16383) et de la constante maximale/import (16380). Notre validation n'est pas modifiée. `SessionRecord.serialize` échoue toujours sur une session réelle contenant un `bigint`, tandis que la persistance normale SQLCipher fonctionne. Aucun sérialiseur de session applicatif n'est introduit ; le snapshot de test utilise le codec V8 exclusivement pour comparer l'état entre processus Node.

## Limites et revue

Les scénarios restent locaux à Node. La confiance des contacts, l'authentification et les garanties du relay réel, l'autorisation individuelle, le vol d'une identité commune, les groupes, la rotation et le comportement mobile exigent leur qualification propre. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent bloquants pour la production. L'évaluation mobile et le coffre ne sont pas commencés.

La revue doit porter particulièrement sur la substitution effective du bundle, les assertions négatives d'état, la suppression des sessions propres, l'isolation des versions et la durée de vie des secrets temporaires. La conservation de l'alias historique évite une preuve dépendant d'une installation manuelle ultérieure ; supprimer 14.4.0 aurait rendu la comparaison non reproductible.

## Vérifications du jalon

Les quatre scénarios ciblés (substitution/épingle pour chacune des deux versions, reprise 14.5.0 et migration 14.4.0 → 14.5.0) réussissent. La suite globale `pnpm test` rejoue les tests d'identité, d'import, de fanout, de révocation expérimentale, de refus terminal, d'idempotence, de persistance, de registration ID et de transfert ainsi que ceux de `crypto-core` et `crypto-backup`. `pnpm typecheck`, `pnpm lint`, `pnpm format:check` et la compilation des trois packages cryptographiques réussissent. Un ordre d'import signalé par le lint a été corrigé ; aucune assertion de sécurité existante n'a été assouplie. Les versions réellement résolues ont été contrôlées : moteur 14.5.0, alias de test 14.4.0.

Message de commit proposé : `fix(crypto-engine): upgrade OpenE2EE to 14.5.0 with security regression coverage`. Les modifications restent non commitées pour revue.
