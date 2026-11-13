# Audit de transition E2EE et pérennité du moteur

**Date :** 13 novembre 2026  
**Statut :** analyse technique et documentaire terminée, conclusions à revoir ; aucune validation de production et aucun POC supplémentaire autorisé.

## Décision et périmètre

**Recommandation B : poursuivre provisoirement l'évaluation d'OpenE2EE 14.4.0**, avec expériences ciblées et critères d'arrêt. L'import de l'identité commune est démontré dans les conditions des tests Node ; les parcours complets de messagerie, révocation, coffre et récupération ne le sont pas. Aucune incompatibilité fondamentale n'impose à ce stade l'abandon de cette identité ni une réécriture générale.

La cible fonctionnelle est un compte à mot de passe unique, une clé maître de coffre aléatoire indépendante, deux enveloppes versionnées et une clé de récupération aléatoire. L'authentification et l'autorisation e-mail précèdent l'accès protégé. Le serveur d'authentification reçoit le mot de passe sur TLS : un serveur activement compromis peut le capturer et potentiellement déchiffrer le coffre. L'architecture est cohérente sous cette hypothèse, mais sa sécurité opérationnelle reste à démontrer. Les détails et parcours font référence à [l'architecture du coffre](../security/recovery-vault-architecture.md), à [l'archive et la récupération](../security/encrypted-archive-and-recovery.md) et au [modèle de menaces](../security/threat-model.md).

Le jalon documentaire ne modifie pas le code et ne valide pas les algorithmes, formats ou fournisseurs. Les anciennes décisions sont conservées dans leurs documents, avec un statut historique lorsqu'elles sont remplacées.

## État du dépôt et réutilisation

| Élément                                                       | État réel au moment de l'audit                                                                                                                 | Décision proposée                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `contracts` et `validation`                                   | Point d'entrée de contrats vide ; schéma e-mail Zod testé.                                                                                     | Conserver ; ne pas anticiper de contrats inutiles.                                                                              |
| `crypto-core`                                                 | Identifiants et descripteurs logiques compte/appareil et erreurs ; tests unitaires.                                                            | Conserver, indépendant du SDK. Les descripteurs ne prouvent pas l'autorisation.                                                 |
| `crypto-engine`                                               | Vérification des paires d'identité, préparation et import contrôlé ; tests Node et caractérisation du transfert.                               | Conserver et adapter ; import non conditionnel atomiquement entre écrivains.                                                    |
| `crypto-backup`                                               | Validation structurelle, chiffrement/ouverture directs expérimentaux, contrat d'aléa et charge binaire candidate ; tests de succès et d'échec. | Conserver les contrôles et vecteurs utiles ; remplacer le coffre direct comme cible, sans supprimer son historique avant revue. |
| Coffre à deux enveloppes, autorisation, messagerie et archive | Aucun parcours complet implémenté ou validé.                                                                                                   | Concevoir progressivement ; aucun package supplémentaire n'est imposé.                                                          |

La charge `RecoveryPayloadV1` contient les deux paires d'identité et de 0 à 64 secrets d'archive opaques ; elle ne démontre ni la conversion vers le SDK ni la complétude de l'historique. Son format est lié au profil d'identité étudié. Voir [la charge expérimentale](../security/recovery-payload-v1.md) et [le coffre direct historique](../security/recovery-vault-direct-v1.md).

## Résultats OpenE2EE 14.4.0

Les références suivantes visent le SDK installé sous `packages/crypto/engine/node_modules/@open-e2ee/signal-protocol-sdk`, dont la version est épinglée dans le manifest et le lockfile du dépôt.

### Confirmé par le code ou par les tests du dépôt

- `dist/keys/types.d.ts`, `IdentityKeyPair` : identité composite avec paires X25519 et Ed25519 et registration ID. `dist/types/api.d.ts`, `IdentityKeyStore` : stockage public et exemple de mêmes clés avec registration ID local distinct.
- `dist/device/types.d.ts`, `DeviceBackup` ; `dist/device/transfer.js`, `createDeviceBackup` et `restoreDeviceBackup` : export/import de l'identité seule, sans sessions, préclés ou historique. L'intégrateur doit fournir la transaction de restauration. L'adaptateur d'export doit sélectionner les champs nécessaires, car l'objet d'identité renvoyé est recopié.
- Les tests [de transfert](../../packages/crypto/engine/tests/device-transfer-characterization.test.ts) et [de persistance](../../packages/crypto/engine/tests/node-store-persistence.test.ts) exercent l'identité dans des stores Node séparés, dont une réouverture de SQLCipher. Ils ne démontrent pas une conversation multi-appareils complète.
- `dist/remote/signal-relay/types.d.ts`, `removeDevice` prévoit le retrait du registre, des préclés et des enveloppes en attente. `dist/internal/sesame/manager.js`, `removeDeviceLocked` marque un appareil retiré et archive une session pour les messages antérieurs. Ces observations sur le code interne servent à comprendre le comportement, sans constituer une API publique à utiliser par Bunny Talks.
- `dist/client/client.js`, `rotateAccountIdentity` publie l'identité de remplacement déjà présente localement avec un engagement attendu, puis synchronise des préclés. Elle ne constitue pas à elle seule une procédure complète de rotation de compte et de vérification des correspondants.
- Les tests du projet montrent qu'un paquet de transfert peut être rejoué ou substitué lorsque l'appelant ne fournit pas d'authentification complémentaire. Ils ne démontrent pas un rejeu d'une autorisation applicative qui n'existe pas encore.

### Documenté mais non vérifié expérimentalement dans Bunny Talks

Le SDK documente PQXDH et le ratchet avec évolution de clés, clés sautées bornées, multi-appareils et adaptateurs Expo/SQLCipher. Leurs garanties dépendent notamment de l'établissement authentifié, de l'aléa, de la persistance et de la vérification des changements d'identité. Les tests Node du dépôt ne prouvent ni la compatibilité Hermes/iOS/Android ni la récupération après redémarrage d'une conversation complète. JavaScript ne garantit ni temps constant machine ni effacement complet des secrets.

Le document `docs/ASSURANCE.md` du SDK indique que les tests d'ingénierie et leurs fixtures sont privés et qu'aucun audit indépendant n'est engagé. Les résultats chiffrés et la couverture d'interopérabilité annoncés par le mainteneur n'ont pas été reproduits. Une revue automatisée par IA ne constitue pas un audit indépendant.

### Points à caractériser et incompatibilités

- Le générateur `generateRegistrationId` peut produire 1 à 16383, tandis que la constante publique `MAX_REGISTRATION_ID` utilisée par notre import vaut 16380. Les valeurs 16381 à 16383 sont donc rejetées par l'import actuel. Résoudre cette divergence avant intégration fiable.
- `SessionRecord.serialize` utilise `JSON.stringify` ; le codec des stores gère explicitement `bigint`, `Map` et `Uint8Array`, présents dans des types d'état. Caractériser un état réel et les round-trips par API publiques avant tout export de session. Ce constat n'établit pas une vulnérabilité exploitable ni une panne du codec persistant.
- Le SDK documente un profil propre, avec identité composite, signatures et formats de messages différents de libsignal. **L'interopérabilité sur le fil avec libsignal n'est pas supportée.** Partager des noms de primitives ne rend ni les messages ni les sessions interchangeables.
- L'accès direct au registre npm et à certaines pages d'avis de sécurité était indisponible lors de l'audit. La dernière version réellement publiée, sa date exacte, les contributeurs indépendants et l'inventaire exhaustif des avis restent à confirmer. Le dépôt public indique une première alpha publique en juillet 2026 ; cela ne date pas le travail privé antérieur.

Le package installé déclare la licence MIT ou Apache-2.0. Les versions résolues incluent Noble 2.4.0, `@noble/post-quantum` 0.7.1 et `better-sqlite3-multiple-ciphers` 13.0.3 ; les notices des composants distribués doivent être revues. Le fork du client est techniquement et juridiquement envisageable sous les conditions des licences, mais les tests principaux, le service hébergé et certains composants serveur ne sont pas publics. Une reprise fiable exige une capacité de maintenance et de validation propre.

## Écarts et risques bloquants

1. **SEC-CRYPTO-002 :** l'import actuel vérifie puis écrit, mais ne garantit pas une création conditionnelle atomique entre tous les écrivains, ni la reprise après panne et état partiel. Voir [ADR-003](decisions/003-open-e2ee-evaluation.md).
2. **SEC-CRYPTO-003 :** l'autorisation individuelle liée à une demande e-mail, l'anti-rejeu et la reprise ne sont pas implémentés. L'accès protégé doit suivre cette autorisation.
3. **Coffre :** le format direct expérimental dérive une clé du secret de récupération ; il n'implémente ni enveloppe par mot de passe, ni clé maître indépendante commune aux deux accès. Une source aléatoire silencieusement défaillante peut produire sel et nonce nuls. La vérification de compte attendu, la fraîcheur et l'autorisation sont distinctes de l'AEAD.
4. **Identité et révocation :** retirer une autorisation serveur n'efface aucune copie locale. Une clé privée commune volée peut permettre une usurpation ; une rotation exceptionnelle de l'identité et une nouvelle vérification des contacts peuvent être nécessaires. Les nouvelles clés d'archive doivent être indépendantes des secrets compromis.
5. **Historique :** l'identité seule ne régénère pas les clés de messages consommées. Les contenus jamais reçus ou jamais archivés, les objets manquants et les anciennes versions peuvent être irrécupérables. Les secrets d'archive durables augmentent l'exposition de l'historique s'ils sont compromis. L'authenticité sous une clé partagée ne prouve pas nécessairement la provenance d'un contenu.
6. **Fraîcheur :** sans référence indépendante, un appareil vierge ne peut pas toujours distinguer le coffre actuel d'un ancien coffre authentique présenté par un serveur malveillant.

Le changement ordinaire de mot de passe conserve les autres appareils autorisés. Une réinitialisation par e-mail ne déchiffre pas le coffre ; il faut ensuite la clé de récupération ou l'intervention cryptographiquement valide d'un appareil encore autorisé. Le réenveloppement ne révoque pas une ancienne copie obtenue avec l'ancien secret. La publication du vérificateur et de l'enveloppe doit gérer versions, concurrence, atomicité et reprise ; elle reste à concevoir.

## Alternatives et sortie du moteur

| Option                                                           | Intérêt                                                             | Limites à vérifier                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| OpenE2EE et primitives déjà présentes pour un coffre indépendant | Réutilisation du prototype, pas de nouvelle bibliothèque immédiate. | Noble et ses dépendances ne sont pas validés automatiquement pour la production ou Hermes ; les paramètres doivent être mesurés. |
| OpenE2EE et libsodium pour coffre/contenus                       | Primitives natives candidates, dont Argon2id et AEAD.               | Binding, versions, builds et interopérabilité à vérifier ; duplication possible des primitives.                                  |
| libsignal et coffre indépendant                                  | Moteur officiel utilisé par Signal.                                 | Usage tiers non supporté, licence AGPLv3, ponts mobiles et maintenance à évaluer.                                                |

Libsodium est une bibliothèque de primitives, pas un protocole complet de messagerie. Elle ne remplace ni les sessions, ni le Double Ratchet, ni la gestion des appareils. Construire ces mécanismes soi-même n'est pas recommandé.

La portabilité des données, des clés et des sessions est distincte. Une sortie progressive supposerait un format d'archive indépendant, de nouvelles sessions, une continuité d'identité authentifiable, une coexistence temporaire protégée contre le downgrade et une politique pour les appareils longtemps hors ligne. Les préclés, sessions et ciphertexts propres à OpenE2EE ne sont pas supposés importables dans libsignal. Un ancien moteur seul ne restaure pas les clés de messages déjà consommées. Les messages en attente peuvent encore être délivrés si les données et états nécessaires sont disponibles ; ils peuvent sinon nécessiter une réémission. Les contenus jamais synchronisés ou archivés peuvent être perdus après perte totale.

Sources officielles : [libsignal](https://github.com/signalapp/libsignal/blob/main/README.md), [libsodium et Argon2id](https://doc.libsodium.org/password_hashing/default_phf), [XChaCha20-Poly1305](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction). L'audit libsodium publié concerne des versions historiques et ne valide pas un binding mobile ni notre composition.

## Plan minimal et critères de décision

| Étape future              | Objectif et dépendance                                                                                              | Acceptation et risque principal                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Identité et révocation | POC Node avec API publiques : identité commune, sessions propres, persistance et retrait. Après revue explicite.    | Échanges et reprise reproductibles ; comportement des appareils retirés et limites d'usurpation documentés. Les anomalies de registration ID et sérialisation sont caractérisées. |
| 2. Plateformes            | Qualifier Expo/Hermes, SQLCipher, aléa et primitives ; comparer un binding natif si justifié.                       | Tests iOS et Android, échecs fermés, interopérabilité, mesure temps/mémoire. Les succès Node ne suffisent pas.                                                                    |
| 3. Coffre                 | Après validation du format et des fournisseurs, adapter `crypto-backup` aux deux enveloppes.                        | Tests de corruption, échec, changement de mot de passe, réinitialisation, concurrence et reprise. Ne pas supposer que la publication est atomique.                                |
| 4. Appareils              | Implémenter authentification, demande e-mail et autorisation individuelle, maximum cinq, puis révocation distincte. | Aucun accès protégé avant autorisation ; anti-rejeu, expiration, courses et canaux persistants testés.                                                                            |
| 5. Archive                | Étudier puis réaliser le modèle minimal indépendant du transport. La proposition CRYPTO-014 reste non approuvée.    | Restauration sur appareil vierge des contenus effectivement conservés et des clés, détection des lacunes possibles et tests de pannes.                                            |
| 6. Production             | Après les étapes précédentes, revue de sécurité indépendante, licences, maintenance et stratégie de sortie.         | Validation humaine explicite des garanties et risques résiduels.                                                                                                                  |

La poursuite du prototype requiert des API publiques suffisantes, une récupération crédible des secrets nécessaires, des sessions indépendantes vérifiées et des limites de révocation explicites. Réévaluer ou suspendre OpenE2EE si une exigence fondamentale impose des API internes instables, si une récupération indispensable est impossible, si aucun mécanisme de révocation acceptable n'est envisageable, si un défaut cryptographique est démontré ou si la maintenance devient déraisonnable.

Avant production, satisfaire ces critères ne dispense pas de l'audit indépendant, de tests natifs et de l'évaluation de la chaîne d'approvisionnement. La jeunesse du projet ou l'absence d'audit ne démontre pas seule une incompatibilité ; des tests fonctionnels réussis ne démontrent pas sa sécurité.

**Prochain jalon envisagé :** étape 1 uniquement, après revue et autorisation explicite. Aucun POC n'est commencé dans le jalon documentaire.
