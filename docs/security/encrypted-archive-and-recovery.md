# Archive chiffrée, sauvegarde et récupération

**Projet :** Bunny Talks  
**Statut :** Décisions fonctionnelles validées — conception technique à vérifier  
**Priorité :** Exigence fondamentale de sécurité et de fiabilité

## 1. Objectif

Bunny Talks doit permettre à chaque utilisateur de conserver durablement ses communications privées et de les retrouver après un changement ou une perte d'appareil.

L'objectif produit est de retrouver aussi complètement que possible les lettres, conversations, médias et données de modules partagés conservés après la perte d'un téléphone. Cette exigence ne garantit pas la récupération des données qui n'ont pas été effectivement synchronisées ou archivées, ni la disponibilité des copies et clés nécessaires.

Cette exigence doit être intégrée à l'architecture dès le départ, même si certaines fonctionnalités de sauvegarde et de restauration sont implémentées ultérieurement.

## 2. Contenu de l'archive personnelle

L'archive doit conserver :

- Les lettres envoyées et reçues.
- L'intégralité des messages de chat envoyés et reçus.
- Les pièces jointes et médias conservés.
- Les brouillons de lettres et de messages.
- Les informations nécessaires à l'organisation chronologique des conversations.
- Les données cryptographiques durables nécessaires à la continuité de l'identité du compte.

Les messages éphémères sont exclus de l'archive permanente après leur expiration, conformément à leur fonctionnement.

Chaque utilisateur possède sa propre copie chiffrée des communications qu'il a envoyées ou reçues. La suppression personnelle d'une copie ne doit pas entraîner automatiquement la suppression de celle de l'autre correspondant.

La restauration vise les contenus reçus ou envoyés qui ont été effectivement archivés, tant que les objets chiffrés et les clés nécessaires restent disponibles et utilisables. La récupération intégrale de ces éléments est un objectif fonctionnel ; aucun parcours complet ni garantie de disponibilité n'est encore démontré.

## 3. Synchronisation et sauvegardes

La synchronisation chiffrée régulière doit transmettre les communications et autres données à conserver après leur modification, afin de permettre leur récupération sans attendre la sauvegarde quotidienne. Sa fréquence, ses accusés de réussite et la gestion des interruptions restent à définir ; les données non encore synchronisées lors d'une perte peuvent être irrécupérables.

Les messages encore en attente de distribution ne font pas nécessairement partie d'une archive déjà reçue et déchiffrée. Leur récupération dépend de leur disponibilité, des préclés ou états de session nécessaires et du parcours de livraison ; une réémission peut être nécessaire. Les données locales jamais synchronisées ou archivées peuvent être perdues avec l'appareil. Les capacités de reprise correspondantes restent à concevoir et à tester.

Les sauvegardes périodiques constituent des points de reprise distincts de cette synchronisation. Les snapshots sont des états datés de référence facilitant une restauration efficace ; ils ne remplacent pas la synchronisation des changements récents.

Le système doit proposer :

- Une sauvegarde automatique quotidienne lorsque des changements ont été effectués.
- Une sauvegarde manuelle à la demande.
- Une sauvegarde automatique des brouillons pendant leur rédaction.
- Une synchronisation chiffrée des brouillons entre appareils autorisés.
- La conservation de versions récentes des brouillons afin de permettre leur restauration après une modification accidentelle.
- Une indication visible de la date de la dernière sauvegarde réussie.

Les sauvegardes doivent être incrémentales lorsque cela est pertinent, avec des snapshots périodiques permettant une restauration efficace.

## 4. Architecture cryptographique

Une archive durable indépendante des sessions de chiffrement utilisées pour transporter les messages est la solution à étudier pour satisfaire la récupération. Son architecture, sa faisabilité et ses garanties ne sont pas encore validées.

Les clés Double Ratchet et les clés de session temporaires ne doivent jamais constituer l'unique moyen de retrouver les anciens messages.

Principes retenus :

- Les données sont chiffrées sur l'appareil avant leur transmission.
- Le serveur ne stocke que des données chiffrées.
- Les clés de l'archive sont distinctes des clés de session.
- Les clés de l'archive sont protégées par une hiérarchie de clés durable.
- Le secret de récupération permet de retrouver les clés nécessaires sans dépendre d'un ancien appareil.
- Les pièces jointes, miniatures et métadonnées sensibles sont également protégées.
- Les mécanismes d'intégrité permettent de détecter les corruptions ou modifications non autorisées.

La conception exacte de la hiérarchie de clés devra être validée avec le SDK cryptographique retenu avant toute implémentation définitive.

## 5. Ajout d'un nouvel appareil

Le parcours cible ne nécessite pas d'ancien appareil :

1. Il installe Bunny Talks sur son nouvel appareil.
2. Il se connecte avec son e-mail et son mot de passe et initie une demande identifiable d'ajout.
3. Il valide un lien e-mail expirant et à usage unique, lié à cette demande ; l'appareil obtient son autorisation individuelle.
4. Après autorisation, il accède au coffre chiffré et le déverrouille localement avec le même mot de passe.
5. Il restaure l'identité durable, puis synchronise l'archive disponible et crée ses propres sessions et préclés, selon des mécanismes à valider.

Aucun accès aux données protégées ne doit précéder l'autorisation requise. La liaison de la demande à l'appareil, l'anti-rejeu, l'activation finale et la gestion des cinq places restent à concevoir et à tester. La comparaison historique d'ordre dans CRYPTO-004 est remplacée par cette décision.

L'association par QR code est facultative et reportée. Si elle est mise en œuvre, le QR code ne doit jamais contenir directement de clé privée durable et son parcours devra être évalué séparément.

## 6. Récupération après perte de tous les appareils

La récupération ne doit pas nécessiter l'accès à un ancien appareil.

Un coffre de récupération chiffré est donc indispensable.

Avec le mot de passe connu, l'utilisateur s'authentifie, autorise son nouvel appareil par e-mail, puis déverrouille le coffre localement avec ce mot de passe. La révocation éventuelle des anciens appareils est une action distincte.

Après oubli du mot de passe, la réinitialisation par e-mail ne déchiffre pas le coffre. L'utilisateur doit ensuite fournir sa clé de récupération aléatoire ou bénéficier d'une intervention cryptographiquement valide d'un appareil encore autorisé. Sans ces moyens, l'accès aux anciennes données ne peut pas être promis. Après perte totale des appareils, seule la clé de récupération permet ce parcours si le mot de passe est oublié.

La clé de récupération doit être présentée dès l'inscription, accompagnée d'instructions pour la conserver hors du seul appareil. La restauration du coffre, de l'identité et des données sauvegardées reste à implémenter et à tester.

La récupération doit être testée avant de considérer un compte comme correctement protégé.

## 7. Gestion des appareils

Un compte peut posséder au maximum cinq appareils de confiance autorisés.

Les appareils de confiance partagent une identité cryptographique durable du compte. Ils conservent leurs propres identifiants d'enregistrement, sessions, préclés et clés locales de stockage lorsque le protocole l'exige. L'accès à l'historique par une archive chiffrée indépendante reste à concevoir et valider ; la récupération sans ancien appareil est distincte du transfert entre appareils.

OpenE2EE Signal Protocol SDK 14.5.0 demeure un candidat en évaluation, sans choix de production définitif.

Fonctionnalités prévues :

- Liste des appareils autorisés.
- Identification du type d'appareil et de sa dernière activité.
- Révocation individuelle.
- Action « Révoquer tous les autres appareils ».
- Confirmation par le mot de passe du compte.
- Conservation de l'appareil courant lors d'une révocation globale.
- Notification de sécurité lors d'un ajout, d'une révocation ou d'une récupération.

La révocation serveur empêche les accès futurs selon la frontière d'autorisation effective ; l'exclusion cryptographique des futures distributions exige des mécanismes et rotations à valider. Elle ne peut pas effacer les données déjà copiées ou déchiffrées. Si l'identité privée commune a été compromise, sa rotation exceptionnelle et une nouvelle vérification de confiance peuvent être nécessaires.

L'action « Révoquer tous les autres appareils » nécessite le mot de passe du compte et conserve l'appareil demandeur. Elle doit invalider les sessions et autorisations des autres appareils et renouveler les éléments cryptographiques nécessaires aux futurs échanges. Dès la révocation effective, le serveur refuse les sessions révoquées même si leurs jetons subsistent localement ; les appareils hors ligne sont refusés lors de leur prochaine tentative. Cela n'efface pas leurs données locales. Les connexions simultanées ordinaires restent autorisées ; un changement ordinaire du mot de passe conserve tous les autres appareils connectés et autorisés.

## 8. Stockage et résilience

Le système doit prévoir :

- Un stockage serveur chiffré.
- Des sauvegardes serveur indépendantes.
- Une réplication adaptée à la criticité des données.
- Des contrôles réguliers d'intégrité.
- Des snapshots et points de reprise versionnés.
- Une procédure de restauration après corruption ou incident.
- Une surveillance des échecs de sauvegarde.
- Une gestion des synchronisations interrompues ou concurrentes.

Le serveur ne doit pas avoir besoin de déchiffrer les contenus pour gérer les sauvegardes et leur restauration.

## 9. Suppression et conservation

La suppression d'un compte, d'une conversation ou d'un message doit suivre des règles explicites.

- **Suppression personnelle :** la suppression demandée par un utilisateur concerne sa propre copie et son archive, selon les règles de propagation et de conservation retenues. Elle ne supprime pas automatiquement les copies ou archives des autres correspondants.
- **Suppression pour tous :** fonctionnalité retenue pour les messages. Une demande valide doit entraîner immédiatement la suppression logique du message côté serveur et rendre ses copies chiffrées concernées inaccessibles par les accès ordinaires, puis propager la suppression aux appareils des participants. Les conditions d'utilisation et la frontière exacte de prise d'effet restent à spécifier et à tester.

Les responsabilités suivantes doivent être assurées sans confondre leurs délais :

1. **Serveur :** dès la prise d'effet de la demande, refuser l'accès et la distribution du message supprimé, y compris aux copies chiffrées conservées pour les participants. Traiter les opérations concurrentes afin d'éviter sa réapparition par une écriture ou une synchronisation tardive.
2. **Appareils :** propager la demande authentifiée et supprimer les copies locales et éléments d'archive concernés. Un appareil hors ligne applique la suppression à sa reconnexion ; les reprises, échecs et éventuels accusés restent à concevoir.
3. **Archives et sauvegardes :** conserver et propager les tombstones nécessaires pour qu'une restauration, y compris depuis un ancien snapshot ou une sauvegarde, n'expose pas à nouveau un message supprimé pour tous. Avant de rendre des contenus restaurés accessibles, prendre en compte les suppressions applicables ; définir le comportement lorsque leur état ne peut pas être établi, ainsi que leur durée de conservation et leur cohérence entre appareils.
4. **Effacement physique :** supprimer les objets chiffrés, copies et sauvegardes concernés selon les politiques de stockage, de purge et de conservation applicables. La suppression logique immédiate ne démontre pas un effacement physique instantané sur tous les supports ou appareils.

Les mécanismes de tombstones, leur authentification, leur fraîcheur et le traitement des sauvegardes restent à concevoir et tester. Un serveur malveillant peut masquer une suppression ou présenter un ancien état ; sans référence fiable de fraîcheur, la détection d'une omission n'est pas garantie. L'effacement ne peut pas être imposé aux copies déjà exportées, enregistrées ou déchiffrées par un destinataire.

En particulier :

- La suppression d'une lettre chez son expéditeur ne doit pas supprimer automatiquement la copie déjà reçue.
- La suppression d'un compte ne doit pas faire disparaître les lettres et messages conservés légitimement par les destinataires.
- Les données personnelles supprimées doivent être traitées conformément aux obligations légales applicables.
- Les sauvegardes doivent intégrer des mécanismes de suppression différée et de propagation des suppressions lorsque nécessaire.

Les durées de conservation et les règles exactes de suppression devront être définies dans la politique de confidentialité et les spécifications fonctionnelles.

## 10. Tests obligatoires

Avant validation de l'architecture, les scénarios suivants doivent être testés :

- Restauration sur un nouveau téléphone des contenus effectivement archivés et de leurs clés disponibles.
- Récupération après perte du dernier appareil.
- Restauration des lettres et des messages de chat effectivement conservés.
- Restauration des pièces jointes.
- Récupération de l'identité cryptographique.
- Conservation des archives après rotation des clés de session.
- Sauvegarde interrompue par une perte réseau.
- Restauration après corruption de la base locale.
- Restauration après corruption d'une sauvegarde.
- Suppression pour tous : refus immédiat côté serveur, propagation après reconnexion et absence de réapparition après restauration d'une ancienne sauvegarde, y compris en cas de synchronisation concurrente.
- Synchronisation de brouillons depuis plusieurs appareils.
- Révocation d'un appareil perdu.
- Ajout et révocation successifs d'appareils.
- Restauration d'une archive ancienne après plusieurs mois.
- Vérification de l'intégrité des données restaurées.

Les tests doivent être automatisés autant que possible et conservés dans les packages de production concernés.

## 11. Limites et transparence

Bunny Talks doit viser une conservation extrêmement fiable, mais ne doit pas promettre une récupération absolue dans toutes les circonstances.

Les messages en attente de distribution ne sont pas nécessairement archivés ; ceux dont la livraison ou les clés ne sont plus disponibles peuvent être irrécupérables. Les données non synchronisées ou jamais archivées, les objets manquants ou corrompus et les archives indisponibles peuvent aussi entraîner une récupération incomplète. Si tous les appareils sont perdus et que ni le mot de passe valable ni la clé de récupération ne permettent d'ouvrir un coffre exploitable, les données peuvent devenir irrécupérables.

Une ancienne archive authentique peut être obsolète : sans référence de fraîcheur indépendante, un appareil vierge ne peut pas toujours détecter le retour arrière imposé par un serveur malveillant. La conservation de secrets d'archive durables facilite la restauration mais leur compromission peut exposer les anciens contenus, même après évolution des sessions de transport. L'authenticité sous une clé d'archive commune ne prouve pas à elle seule la provenance d'un contenu partagé.

Le système doit donc aider activement l'utilisateur à protéger son secret de récupération et à vérifier que ses sauvegardes sont opérationnelles.

## 12. Principe architectural fondamental

**Les sessions cryptographiques servent à communiquer. L'archive chiffrée sert à conserver.**

Ces deux responsabilités sont distinctes et doivent rester indépendantes.

Les décisions concernant le SDK cryptographique, le stockage et la synchronisation doivent préserver l'objectif de retrouver durablement les lettres, conversations et brouillons conservés, dans les limites de disponibilité décrites ci-dessus.

## 13. Limite de l'import d'identité en évaluation

La préparation d'une identité vérifie la cohérence de ses clés sans authentifier sa provenance. L'import contrôlé refuse une identité déjà détectée et vérifie l'écriture dans un store SQLite, mais le contrôle préalable et l'écriture ne sont pas atomiques. Sa sérialisation locale ne couvre ni les autres processus ni les écritures SDK directes. L'appelant doit exclure les autres écrivains ; un état corrompu ou un échec d'écriture ou de relecture exige une procédure de reprise sûre. La coordination durable, l'authentification du transfert et le comportement après panne doivent être validés avant l'association ou la récupération en production.

L'absence d'identité ne prouve pas qu'un store est vierge : il peut déjà contenir des préclés, des sessions ou d'autres données. L'opération actuelle ne vérifie pas leur absence ou leur cohérence. Un état inconnu ou partiel doit rester isolé et ne doit pas être automatiquement réinitialisé. Après une écriture potentiellement réussie suivie d'une erreur, conserver le store et son coffre, empêcher l'activation et les nouvelles écritures, puis appliquer une procédure de diagnostic et de reprise authentifiée qui reste à définir et à tester.

L'exigence bloquante **SEC-CRYPTO-002**, définie dans ADR-003 et suivie dans le jalon courant, impose les garanties de création conditionnelle, de protection des chemins d'écriture, de reprise après panne, de gestion des états partiels et de tests de concurrence sur les backends réels avant toute association ou récupération d'appareil en production.

## 14. Transfert entre appareils : authentification à valider

La possession du coffre et de l'identité commune ne suffit pas à établir l'autorisation individuelle d'un appareil. Tout parcours d'ajout ou de récupération doit satisfaire le volet général de **SEC-CRYPTO-003**, ouvert et bloquant avant production : authentification, autorisation, protection contre les substitutions et rejeux, expiration et reprise sûre. Le volet spécifique au transfert QR reste ouvert et devra être satisfait avant tout usage de cette option reportée. **SEC-CRYPTO-002 reste bloquant.**
