# ADR-003 — Évaluation d'OpenE2EE 14.4.0

**Actualisation du 14 novembre 2026 :** migration expérimentale Node vers OpenE2EE 14.5.0 autorisée et réalisée. Le [rapport de migration](../../development/open-e2ee-14-5-migration.md) distingue les tests adversariaux, la compatibilité SQLCipher et les limites restantes. Les constats 14.4.0 ci-dessous restent historiques. La qualification mobile est la prochaine étape envisagée ; SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

**Statut au 14 novembre 2026 : recommandation B retenue pour l'évaluation** — poursuivre provisoirement les expériences avec OpenE2EE, désormais en 14.5.0 ; aucun choix de production définitif. Le POC multi-appareils est terminé et validé au niveau expérimental sous Node ; aucune validation de production n'en découle.

## Contexte

Le projet examine les capacités du SDK pour le modèle multi-appareils et la récupération.

## Proposition

Isoler OpenE2EE dans `crypto-engine` et vérifier ses API publiques, son comportement et sa compatibilité mobile avant toute décision de production.

## Alternatives

D'autres bibliothèques, notamment libsignal, restent candidates ; choisir maintenant sans intégration ni audit suffisant serait prématuré.

Libsignal offre un moteur officiel utilisé par Signal, mais les usages tiers ne sont pas supportés, la distribution AGPL et les ponts natifs Expo restent à évaluer. Libsodium fournit des primitives candidates pour le coffre et les contenus, pas un protocole de messagerie. Son ajout exigerait une justification et une qualification du binding. Aucun changement de bibliothèque n'est décidé. Voir [l'audit de transition](../e2ee-transition-audit.md).

## Conséquences

Les essais doivent rester réutilisables et couvrir les pannes. La cohérence d'une paire de clés ne prouve pas l'authenticité de sa provenance. Les divergences de bornes de registration ID et la compatibilité native restent à résoudre.

L'examen de CRYPTO-002 ne démontre pas d'import conditionnel atomique avec les API publiques `IdentityKeyStore`. La préparation d'une identité ne constitue pas un import, et le comportement des stores SQLite et clé-valeur pour l'identifiant local doit être testé séparément.

## Éléments et limites de l'évaluation

Les API publiques permettent l'export des deux paires d'identité et leur import avec un registration ID propre à l'appareil. Sous Node, les tests démontrent cet import, sa persistance SQLCipher et des échanges réels entre trois clients, y compris le fanout public vers deux appareils partageant l'identité. La révocation et la production gardent les limites décrites ci-dessous. Le bundle d'identité exclut les sessions, préclés et messages ; il ne restaure pas l'historique à lui seul. Les données de sessions conservées et l'archive requièrent des traitements distincts.

Le projet est publiquement récent, son écosystème et sa maintenance restent à observer. Le document d'assurance livré indique que les principaux tests d'ingénierie ne sont pas publics et qu'aucun audit cryptographique indépendant n'est engagé. Ces déclarations ne constituent ni une preuve de vulnérabilité, ni une validation de sécurité. Les résultats de tests privés et l'interopérabilité annoncée n'ont pas été reproduits ; le profil du SDK n'est pas compatible sur le fil avec libsignal. Expo/Hermes pour Bunny Talks, la récupération intégrale et la révocation après compromission ne sont pas démontrés.

Deux anomalies ont été caractérisées dans les limites décrites ci-dessous : le générateur produit des registration IDs jusqu'à 16383 alors que la constante publique utilisée par notre import limite à 16380 ; le sérialiseur public de sessions utilise JSON simple tandis que les stores persistants disposent d'un codec spécifique pour des types supplémentaires. Le résultat sur une session réelle est décrit ci-dessous ; aucune vulnérabilité exploitable n'est affirmée. Les versions publiées et les avis de sécurité n'ont pas pu être établis exhaustivement lors de l'audit en raison d'accès externes incomplets.

**Poursuite du prototype :** limiter les travaux approuvés à des expériences vérifiables sur les API publiques, l'identité commune, les sessions, la reprise et les frontières de révocation. **Arrêt ou réévaluation :** dépendance incontournable à des API internes pour une exigence fondamentale, impossibilité de restaurer les secrets indispensables, absence de stratégie crédible d'historique ou de révocation, défaut cryptographique démontré ou maintenance devenue déraisonnable. Un manque d'audit ou la jeunesse du projet n'établit pas seul une incompatibilité, mais reste un risque majeur pour une production sensible.

Avant production : résoudre SEC-CRYPTO-002/003, concevoir le coffre et l'archive, valider les parcours sur les appareils réels, examiner les licences et la chaîne de dépendances, assurer des tests et une stratégie de migration, puis obtenir une revue cryptographique indépendante du système livré.

## Import concurrent : options étudiées

Aucune solution de production n'est encore retenue pour SEC-CRYPTO-002 : le contrat public du store SDK ne permet pas de composer la vérification d'absence et `storeIdentityKey` dans une même transaction. Trois pistes restent à évaluer :

- **A — SQLite contrôlé par Bunny Talks.** Une création conditionnelle et l'écriture de l'identité avec son registration ID pourraient partager une transaction durable, avec contrainte d'unicité entre processus. Les stores SQLite du SDK n'exposent toutefois ni leur transaction ni leur schéma comme contrat public ; les manipuler directement serait fragile. Une implémentation de store compatible et une intégration SQLCipher Node et Expo seraient à construire et à tester. Tous les écrivains devraient l'utiliser.
- **B — Store provisoire puis publication exclusive.** Les API SDK permettent d'ouvrir un store sous un nom distinct ; l'identité et son registration ID y bénéficient de la transaction SQLite propre au SDK. Elles ne fournissent pas de publication atomique interprocessus d'un store avec son entrée de coffre. Un registre applicatif durable avec création conditionnelle, des noms uniques et une procédure de reprise seraient nécessaires. Il faudrait traiter les fichiers SQLite et leurs journaux, la clé du coffre, les ressources orphelines et les accès simultanés. Les garanties Expo et l'empêchement des écritures hors coordination restent à démontrer.
- **C — Adaptateur conforme aux interfaces publiques.** Un store ou adaptateur applicatif pourrait centraliser l'identité et proposer une création conditionnelle dans un backend transactionnel. Un simple verrou JavaScript ne protège ni les autres processus ni les écritures directes au store sous-jacent. La délégation des autres méthodes du SDK, les opérations composées et les exigences de conformité doivent être démontrées ; le backend clé-valeur public dispose d'un `atomicWrite` conditionnel, mais le store SDK existant ne compose pas les deux écritures d'identité et de registration ID dans cette opération publique. Le kit de conformité du SDK aide à tester un store personnalisé sans couvrir tous les comportements.

Une création conditionnelle doit refuser ou traiter explicitement l'identité déjà présente et coordonner tous les écrivains ; sa résistance aux interruptions et sa compatibilité mobile exigent des tests réels. Un chiffrement de base, une transaction SQLite et une exclusion entre processus sont trois garanties distinctes. Privilégier l'étude d'une primitive publique fournie par OpenE2EE ; si elle n'est pas disponible, comparer les autres options et leurs garanties avant toute décision d'architecture, sans présumer qu'un adaptateur complet est nécessaire.

## Périmètre clarifié de CRYPTO-002

Pour une initialisation vierge ou une récupération explicite, `importIdentity` refuse toute identité déjà détectée, écrit dans un store SQLite public puis vérifie la relecture. La connexion classique ne doit pas réimporter l'identité. Cette protection contre un remplacement accidentel n'est pas une création conditionnelle atomique : seuls les appels à cette fonction partageant la même instance sont sérialisés localement. Le contrôle des autres écrivains, la reprise après panne et l'authentification restent nécessaires avant la production. La comparaison des trois approches ci-dessus reste pertinente pour ces garanties supplémentaires.

CRYPTO-002 démontre un import et une persistance après réouverture avec SQLCipher sous Node dans les conditions des tests. Il ne valide ni le modèle multi-appareils ni les parcours complets d'association et de récupération.

## SEC-CRYPTO-002 — Garantie obligatoire avant production

**Statut : ouvert ; bloquant avant toute association ou récupération d'appareil en production.** La démonstration technique CRYPTO-002 ne valide pas cette exigence.

Avant utilisation en production, démontrer :

1. La création conditionnelle atomique de l'identité et de son identifiant local, ou un mécanisme équivalent dont les garanties sont établies.
2. La protection contre les remplacements silencieux par tous les chemins d'écriture pertinents, y compris entre instances et processus.
3. Une reprise sûre après panne ou interruption, y compris lorsqu'une écriture a pu réussir avant qu'une erreur soit signalée.
4. Des tests de concurrence et d'intégration sur les backends réellement utilisés.
5. Une gestion cohérente des états partiellement initialisés.

Étudier en priorité l'obtention d'une primitive publique adaptée dans OpenE2EE. Si elle n'est pas disponible, conserver l'option d'un adaptateur transactionnel conforme aux interfaces publiques ; sa réalisation exige une décision d'architecture supplémentaire.

## CRYPTO-003 — Transfert d'identité en évaluation

Les primitives publiques de `device` permettent de chiffrer un bundle contenant l'identité durable et de générer de nouvelles clés éphémères. Le test Node vérifie le transfert et l'import expérimental, mais pas un parcours d'association authentifié. Le QR public contient la clé du nouvel appareil et une date ; les primitives examinées ne démontrent ni l'authentification de l'ancien appareil, ni l'usage unique du QR ou du paquet. Le SDK délègue le transport et sa politique à l'application. Les métadonnées extérieures à la charge chiffrée ne sont pas contrôlées par `decryptBackup`.

`verifyTransferQRCode` vérifie notamment la version, la représentation de la clé et l'âge déclaré par rapport à l'horloge locale, avec tolérance future ; cette date n'est pas une preuve authentifiée de création et le contrôle n'empêche pas un rejeu. L'autorisation du nouvel appareil reste une responsabilité distincte. `createDeviceBackup` reprend l'objet renvoyé par l'adaptateur : `validateBackup` refuse les champs interdits à la racine, mais des données supplémentaires imbriquées dans l'identité peuvent être conservées. Il faut donc sélectionner explicitement les deux paires durables et exclure les données propres à l'appareil à l'export.

`deriveTransferKeys` dérive et retourne deux clés distinctes au moyen de HKDF : `encryptionKey` et `authenticationKey`. Les opérations de transfert distribuées utilisent l'`encryptionKey` pour AES-GCM ; aucun usage de l'`authenticationKey` ni protocole de messages de contrôle associé n'a été identifié dans leurs API ou leur implémentation. Sa dérivation ne prouve donc pas l'authentification des appareils ou des messages. L'intégrité de la charge AES-GCM ne couvre pas à elle seule l'identité des participants, leur autorisation ou l'anti-rejeu : ces garanties restent à définir et à valider pour Bunny Talks.

Le déchiffrement répété d'un paquet est observé dans le test sans état anti-rejeu. Il ne démontre pas l'acceptation répétée d'une autorisation ou d'un enregistrement d'appareil, parcours que ce test n'exécute pas.

Le bundle ne contient que les deux paires si l'adaptateur d'export sélectionne explicitement ces champs. `createDeviceBackup` recopie l'objet de l'adaptateur et `validateBackup` accepte des champs supplémentaires à l'intérieur de l'identité : un adaptateur renvoyant une identité SDK complète transmet aussi son registration ID. Le futur export doit éviter cette transmission accidentelle.

**SEC-CRYPTO-003 : ouvert et bloquant avant production.** Son volet général exige, pour tout ajout ou récupération, l'authentification du compte et l'autorisation individuelle de l'appareil, la liaison à une tentative, la prévention des substitutions et rejeux, l'expiration et la reprise sûre. Le parcours principal utilise le coffre sans ancien appareil ; la possession de l'identité commune n'autorise pas à elle seule l'appareil. Un volet spécifique au QR, facultatif et reporté, exige en outre l'authentification et la liaison des deux appareils avant tout usage de ce transfert. Les garanties doivent être validées par une conception et des tests d'intégration sur les backends réels. **SEC-CRYPTO-002 reste également ouvert et bloquant.**

## Résultats du POC autorisé

Sous Node, trois clients avec stores SQLCipher distincts partagent une identité pour A1 et A2 tout en conservant des sessions propres. Le fanout public `send` a produit deux enveloppes acheminées par une fixture de relay et déchiffrées par les abonnements des deux appareils ; chacun a répondu. La reprise de sessions est démontrée dans trois stores rouverts, et entre deux processus pour une conversation distincte. Voir [le jalon courant](../../development/current-milestone.md) pour les limites et le comportement de révocation.

Après `removeDevice` sur la fixture, le relay refuse l'appareil retiré et ses préclés et messages en attente disparaissent. Un envoi de B1 avec une liste en cache échoue sur l'appareil retiré après avoir déposé une enveloppe pour A1 ; avec un refus `NOT_FOUND`, le SDK clôt cet envoi en identifiant séparément les appareils acceptés et refusés. Les mécanismes de marquage des refus et de comparaison de listes observés dans le SDK ne sont pas exportés publiquement ; aucune utilisation interne ne doit contourner cette limite. Cette issue terminale est démontrée avec la fixture et le SDK testés ; elle dépend d'un transport renvoyant un refus fiable `NOT_FOUND`. La sécurité du relay réel, la persistance métier, les réponses réseau incertaines et les interruptions restent à qualifier. L'autorisation de la fixture ne démontre pas l'authentification d'un backend.

Pour une session réelle, `SessionRecord.serialize` échoue sur un `bigint`, alors que le store persiste et restaure cet état. Le projet n'a pas besoin du helper pour sa persistance SQLCipher actuelle ; un export de sessions ou une autre API qui en dépendrait exigerait sa propre qualification. Les IDs 16380–16383 permettent des échanges directs et la reprise dans les tests, mais notre import refuse toujours les trois derniers ; les autres chemins restent à vérifier. Aucun format de session maison n'est introduit.

Le POC est **terminé et validé au niveau expérimental sous Node** dans les conditions décrites : le fanout et la reprise sont démontrés et un refus terminal explicite permet de clore un envoi partiel sans prétendre l'avoir entièrement livré. Les garanties du relay et les cas d'interruption restent ouverts. Ces résultats ne valident ni les parcours de production, ni la compatibilité mobile, ni la sécurité du SDK.

### Reprise après acceptation partielle

Le contrat public fournit `clientMessageId` et documente une boîte d'envoi conservant les ciphertexts et leur échéance. Dans le test, après perte d'une réponse, rejouer avec le même identifiant ne produit aucune nouvelle copie acceptée ; le relay expérimental retourne l'acceptation mémorisée pour la copie incertaine. L'acquittement et la rediffusion conservent l'identifiant serveur. Les tests ne démontrent pas la durabilité ni la durée de rétention d'un véritable relay.

Après révocation et acceptation partielle, A1 reçoit la copie acceptée. Avec l'erreur générique initiale, la reprise du même envoi reste en échec sur A2, y compris après redémarrage et nouvelle découverte ; un nouvel envoi avec un nouvel identifiant livre une seconde copie visible à A1. Cette erreur générique ne démontre donc pas une résolution ; le refus terminal qualifié ci-dessous apporte une issue explicite. Le besoin d'un protocole de rapprochement des acceptations, d'une déduplication métier et de garanties serveur reste ouvert ; aucun contournement par API interne ni réinitialisation de session n'est retenu.

### Qualification du refus terminal

Avec un `HostedSignalProtocolRelayHttpError` public de code `NOT_FOUND` simulé pour une destination absente, le SDK 14.4.0 clôt l'envoi partiel avec `retryable: false`, `acceptedDevices` contenant A1 et `refusedDevices` contenant A2. L'acceptation relay d'A1 ne prouve pas sa réception ; le test la vérifie séparément. Un nouvel appel avec le même identifiant reproduit le résultat terminal sans nouveau dépôt, y compris après réouverture du client. Le hook `onSendOutcome` rapporte `failed`. Ce comportement dépend d'un refus fiable et authentifié fourni par le transport ; la fixture n'est ni un serveur réel ni une preuve que tous les relays produisent ce code.

L'erreur générique antérieure ne prouvait pas le refus : son résultat restait incertain et `retryable: true` avant l'échéance. `DEVICE_REVOKED` concerne la révocation du client appelant ; il ne doit pas être substitué à un refus de destination. `refusedDestinationCount` concerne l'envoi groupé sur jeton ; `syncPending` concerne les copies vers les autres appareils de l'expéditeur. Aucun ne décrit cet échec direct. Le hook d'issue n'est pas une preuve de réception et peut être perdu après interruption ; l'application doit conserver durablement ses états et traiter les accusés tardifs.

L'API publique `resendMessage` existe pour un envoi terminé, sous condition de contenu conservé. Dans la configuration testée, elle refuse la réémission faute de contenu ; la documentation SDK précise aussi que la déduplication du renvoi dépend du contenu et du chemin de réception. `forgetSentContent` concerne le contenu de groupes et n'est pas une primitive générale d'abandon. Aucune réémission après refus terminal n'est nécessaire pour constater l'exclusion d'A2 : l'opération est close en échec partiel, sans attribuer à A2 une livraison. Une future interface métier peut distinguer cette issue, conserver les preuves et proposer une action explicite ; sa conception et sa persistance restent à valider.

La fixture reconnaît maintenant une acceptation strictement identique avant de vérifier l'activité actuelle du destinataire, tout en authentifiant d'abord l'expéditeur. Le reçu historique ne crée aucune copie et ne réactive pas l'appareil ; une requête différente ou jamais acceptée reste refusée. La durée de rétention, les transactions, les changements de génération d'appareil et la sécurité de ce comportement doivent être spécifiés et testés sur le relay de production.
