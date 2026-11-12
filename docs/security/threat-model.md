# Bunny Talks — Modèle de menaces et exigences de sécurité

**Version : 1.0 — Novembre 2026**

**Statut : modèle initial, à compléter pendant la conception cryptographique**

## 1. Objectif

Ce document identifie les données sensibles de Bunny Talks, les menaces auxquelles elles sont exposées et les protections attendues.

Il constitue la référence de sécurité pour :

- L'architecture backend.
- L'application mobile.
- Les communications privées.
- La gestion des identités cryptographiques.
- Les sauvegardes.
- Les appareils.
- Les notifications.
- La modération.
- Les données personnelles.

L'objectif n'est pas de prétendre éliminer tous les risques.

L'objectif est de définir précisément :

- Ce que nous cherchons à protéger.
- Contre qui.
- Dans quelles conditions.
- Avec quelles protections.
- Avec quelles limites résiduelles.

## 2. Principes fondamentaux

### 2.1. Confidentialité des communications

Les lettres, conversations instantanées, notes éphémères et médias privés doivent être chiffrés de bout en bout.

Le serveur ne doit pas pouvoir déchiffrer ces contenus.

### 2.2. Minimisation des données

Le serveur ne doit conserver que les informations nécessaires au fonctionnement du produit, à la sécurité, à la distribution et aux obligations applicables.

Les métadonnées doivent être considérées comme sensibles, même lorsqu'elles ne contiennent pas le contenu des messages.

### 2.3. Défense en profondeur

La sécurité ne doit pas dépendre d'une seule protection.

Elle repose notamment sur :

- Authentification.
- Autorisation.
- Chiffrement.
- Protection des clés.
- Isolation des composants.
- Validation des entrées.
- Journalisation sécurisée.
- Contrôle des appareils.
- Sauvegardes protégées.
- Tests et audits.

### 2.4. Transparence des limites

Le chiffrement de bout en bout ne garantit pas qu'un appareil compromis soit sûr.

Un destinataire peut copier, photographier ou transmettre un contenu qu'il a déjà déchiffré.

Une révocation ne permet pas d'effacer les informations déjà copiées.

Ces limites doivent être intégrées à la conception et expliquées aux utilisateurs lorsque cela est pertinent.

## 3. Actifs à protéger

### 3.1. Données des utilisateurs

- Adresse e-mail.
- Identifiants de compte.
- Pseudonyme.
- Profil.
- Préférences.
- Langues.
- Relations.
- Paramètres de visibilité.

### 3.2. Contenus privés

- Lettres.
- Messages.
- Notes éphémères.
- Photos.
- Vidéos.
- Médias.
- Souvenirs privés.
- Contenus des espaces partagés lorsque leur confidentialité est attendue.

### 3.3. Identités cryptographiques

- Identité cryptographique durable du compte.
- Identités des appareils.
- Clés privées.
- Clés de session.
- Clés de chiffrement des médias.
- Clés de sauvegarde.
- Secrets de récupération.
- Prékeys et autres éléments du protocole retenu.

### 3.4. Données de sécurité

- Sessions d'authentification.
- Appareils autorisés.
- Certificats et associations d'appareils.
- Journaux de sécurité.
- Événements de révocation.
- Informations de récupération.

### 3.5. Données de modération

- Signalements.
- Éléments de preuve transmis.
- Dossiers.
- Décisions.
- Sanctions.
- Communications officielles.
- Journaux d'audit.

### 3.6. Métadonnées

- Expéditeur et destinataire.
- Horodatages.
- Taille des messages.
- Informations de distribution.
- Nombre d'appareils.
- Fréquence des échanges.
- Informations de connexion.

Ces métadonnées peuvent révéler des informations sur les relations et les habitudes des utilisateurs.

Elles doivent donc être protégées et limitées.

## 4. Acteurs et attaquants envisagés

Le modèle prend en compte plusieurs catégories d'acteurs.

### 4.1. Utilisateur malveillant

Un utilisateur peut chercher à :

- Usurper une identité.
- Harceler un autre utilisateur.
- Contourner les blocages.
- Envoyer du spam.
- Automatiser des inscriptions.
- Abuser des fonctionnalités.
- Extraire des informations auxquelles il n'est pas autorisé à accéder.

### 4.2. Attaquant externe

Un attaquant peut chercher à :

- Compromettre un compte.
- Intercepter des communications.
- Exploiter une vulnérabilité serveur.
- Accéder à une base de données.
- Voler des fichiers.
- Dérober des clés.
- Compromettre un appareil.

### 4.3. Attaquant disposant d'un accès à l'infrastructure

Un accès administrateur ou une compromission de l'infrastructure pourrait permettre :

- La lecture des données non chiffrées côté serveur.
- L'accès aux métadonnées.
- La modification de messages en attente de distribution.
- La perturbation du service.
- La compromission des sauvegardes serveur.

Le chiffrement de bout en bout doit limiter sa capacité à lire les communications privées.

Il ne doit pas être présenté comme une protection contre toutes les formes de compromission du serveur.

### 4.4. Appareil compromis

Un appareil compromis peut exposer :

- Les contenus déchiffrés.
- Les clés accessibles à l'application.
- Les sessions actives.
- Les notifications.
- Les données temporaires.
- Les captures d'écran et fichiers exportés.

La protection des clés par les mécanismes natifs réduit les risques, mais ne garantit pas l'inviolabilité d'un appareil compromis.

### 4.5. Abus interne

Un membre de l'équipe ou un modérateur pourrait chercher à :

- Consulter des données sans justification.
- Abuser des outils de modération.
- Accéder à des dossiers non autorisés.
- Modifier des décisions.
- Extraire des informations personnelles.

Les accès internes doivent être limités, justifiés et journalisés.

### 4.6. Destinataire malveillant

Un destinataire légitime peut :

- Copier un message.
- Faire une capture d'écran.
- Transmettre un média.
- Enregistrer une conversation.
- Partager volontairement des informations reçues.

Le chiffrement ne peut pas empêcher ces actions après déchiffrement.

## 5. Frontières de confiance

L'architecture doit distinguer plusieurs zones de confiance.

### 5.1. Appareil de l'utilisateur

Zone dans laquelle :

- Les clés privées sont utilisées.
- Les contenus sont déchiffrés.
- Les messages sont créés.
- Les médias sont chiffrés.
- Les sauvegardes sont préparées.

L'appareil est une zone sensible.

### 5.2. Serveur Bunny Talks

Zone de confiance limitée.

Le serveur gère :

- Les comptes.
- Les relations.
- Le routage.
- Les métadonnées nécessaires.
- Les messages chiffrés.
- Les appareils autorisés.
- Les notifications.
- Les dossiers de modération.

Le serveur n'est pas autorisé à déchiffrer les communications privées.

### 5.3. Fournisseurs externes

Fournisseurs potentiels :

- Hébergeur.
- Stockage de fichiers.
- APNs.
- FCM.
- Fournisseur d'e-mails.
- Services techniques externes.

Ils ne doivent recevoir que les informations nécessaires à leur fonctionnement.

Les secrets et les données privées ne doivent pas leur être transmis sans nécessité et justification.

### 5.4. Espace de modération

La modération possède un accès distinct et limité aux éléments volontairement transmis par les utilisateurs.

Elle ne doit pas bénéficier d'un accès global aux conversations privées.

Les preuves doivent être séparées des communications ordinaires et protégées par des autorisations spécifiques.

## 6. Modèle de menaces par fonctionnalité

### 6.1. Comptes et authentification

Menaces :

- Vol de mot de passe.
- Credential stuffing.
- Phishing.
- Prise de contrôle de compte.
- Réutilisation de sessions.
- Usurpation d'identité.

Protections attendues :

- Stockage sécurisé des mots de passe côté serveur.
- Protection contre les tentatives répétées.
- Sessions révocables.
- Gestion des appareils.
- Alertes de sécurité.
- Récupération de compte contrôlée.
- Séparation entre récupération du compte et récupération cryptographique.

Le MFA n'est pas prévu dans la V1, mais l'architecture doit permettre de l'ajouter.

**Révoquer tous les autres appareils — décision fonctionnelle :** cette action nécessite le mot de passe, conserve l'appareil demandeur et invalide les sessions et autorisations des autres appareils. Dès que la révocation est effective, le serveur doit refuser les sessions révoquées, même si leurs jetons restent stockés localement. Les connexions simultanées ordinaires restent autorisées. La politique pour un simple changement de mot de passe reste à décider.

Cette exigence concerne les jetons d'accès et de renouvellement ainsi que les connexions persistantes. Un jeton signé vérifié uniquement jusqu'à son expiration ne suffit pas à garantir un refus immédiat : la conception doit prévoir un contrôle d'état serveur cohérent sur tous les points d'accès. Les connexions déjà ouvertes doivent être fermées ou leurs opérations refusées après révocation. Les appareils hors ligne ne reçoivent pas immédiatement l'événement, mais doivent être refusés à leur prochaine tentative serveur. Il faut définir la frontière de révocation effective, traiter les courses et la propagation entre composants, et tester les canaux persistants ; aucune implémentation n'est encore validée.

La révocation des sessions d'authentification ne garantit ni l'effacement des données locales ni la révocation cryptographique des futurs échanges. Les éléments cryptographiques nécessaires à ces échanges doivent être renouvelés ; le mécanisme reste à concevoir et à tester. Voir [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html) pour les considérations de révocation et de propagation des jetons, sans présumer du protocole d'authentification retenu.

### 6.2. Communications privées

Menaces :

- Interception réseau.
- Accès à la base de données.
- Compromission du serveur.
- Vol des clés.
- Réutilisation de messages.
- Modification ou rejeu de messages.
- Usurpation d'un appareil.
- Désynchronisation des sessions.

Protections attendues :

- Chiffrement de bout en bout.
- Authentification cryptographique des messages selon le protocole.
- Protection contre le rejeu.
- Gestion des messages désordonnés.
- Rotation et évolution des clés selon le protocole.
- Vérification de l'identité des appareils.
- Gestion des changements de clés et des révocations.

Le protocole devra être sélectionné après étude approfondie.

### 6.3. Médias

Menaces :

- Accès direct aux fichiers.
- Fuite de métadonnées.
- Exposition de miniatures.
- URL publiques.
- Vol de clés de médias.
- Conservation involontaire de données sensibles.

Protections attendues :

- Chiffrement local avant envoi.
- Clé de média transmise dans un message chiffré.
- Miniatures chiffrées.
- Suppression des données EXIF et GPS.
- Accès contrôlé aux fichiers chiffrés.
- Pas d'URL publique permanente.

### 6.4. Notes éphémères

Menaces :

- Conservation au-delà de la durée prévue.
- Restauration d'une note expirée.
- Présence involontaire dans les sauvegardes.
- Exposition dans les notifications ou caches.

Protections attendues :

- Expiration après 24 heures.
- Exclusion des sauvegardes.
- Gestion de l'expiration côté serveur et client.
- Suppression des données temporaires.
- Gestion adaptée des clés éphémères.

L'expiration ne peut pas empêcher un destinataire de copier le contenu avant sa disparition.

### 6.5. Multi-appareils

Menaces :

- Ajout frauduleux d'un appareil.
- Usurpation d'une demande d'association.
- Vol d'un appareil.
- Maintien d'un appareil révoqué.
- Compromission d'une identité durable.

Protections attendues :

- Identité cryptographique durable commune aux appareils de confiance du compte.
- Identifiants d'enregistrement, sessions, préclés et clés locales de stockage propres à chaque appareil lorsque le protocole l'exige.
- Autorisation individuelle authentifiée, y compris sans appareil existant ; son mécanisme reste à valider.
- Association authentifiée.
- Si l'association facultative par QR code est mise en œuvre : QR temporaire ne contenant aucune clé privée, et échange authentifié.
- Notification des associations.
- Révocation.
- Journalisation des événements de sécurité.

Le modèle exact de délégation et de certification des appareils reste à définir.

Une attention particulière doit être portée au risque qu'une clé d'identité durable partagée entre tous les appareils permette à un appareil compromis d'en autoriser un autre.

Cette question doit être résolue avant la validation de l'architecture cryptographique.

### 6.6. Sauvegardes et récupération

Menaces :

- Vol du coffre de sauvegarde.
- Vol de la phrase secrète.
- Attaque par dictionnaire.
- Corruption de l'archive.
- Restauration d'une archive falsifiée.
- Perte définitive de l'identité cryptographique.
- Restauration d'appareils révoqués.

Protections attendues :

- Phrase secrète distincte du mot de passe du compte.
- Dérivation adaptée au secret ; Argon2id est un candidat à évaluer, notamment pour les secrets humains de faible entropie.
- Sel unique.
- Clé de chiffrement aléatoire.
- Chiffrement authentifié.
- Nonces uniques.
- Versionnement du format.
- Vérification de l'intégrité.
- Restauration contrôlée.
- Révocation des anciens appareils après perte totale.

Les paramètres exacts devront être définis selon les recommandations actuelles et le SDK retenu.

### 6.7. Notifications

Menaces :

- Exposition de contenus dans les notifications.
- Interception de données.
- Fuite de métadonnées.
- Notifications obsolètes.
- Désynchronisation entre appareils.

Protections attendues :

- Enveloppes de notification chiffrées.
- Déchiffrement local.
- Prévisualisation configurable.
- Contenu générique en cas d'échec.
- Alertes de sécurité spécifiques.
- Limitation des informations transmises aux fournisseurs push.

Les fournisseurs push peuvent connaître certaines métadonnées de distribution.

### 6.8. Modération

Menaces :

- Accès abusif aux preuves.
- Fuite de signalements.
- Usurpation de rôle modérateur.
- Modification non autorisée d'une décision.
- Accès excessif aux données.
- Transmission involontaire de messages non sélectionnés.

Protections attendues :

- Preuves sélectionnées explicitement par l'utilisateur.
- Aperçu avant transmission.
- Contexte limité.
- Zone de stockage distincte.
- Accès réservé aux personnes autorisées.
- Journal d'audit append-only.
- Séparation des rôles.
- Conservation limitée.
- Communication officielle séparée des conversations privées.

Aucun accès serveur général aux conversations chiffrées ne doit être introduit pour faciliter la modération.

### 6.9. Espaces partagés

Menaces :

- Accès après rupture d'une relation.
- Modification non autorisée.
- Accès à un espace appartenant à une autre relation.
- Fuite de données entre deux espaces.
- Accès à des contenus après révocation d'un contact.

Protections attendues :

- Autorisation vérifiée côté serveur.
- Vérification de l'appartenance à l'espace.
- Isolation des données.
- Gestion des droits après rupture de relation.
- Historique et traçabilité des opérations sensibles.

La confidentialité cryptographique exacte des modules partagés reste à définir. Elle ne doit pas être présumée identique à celle du chat.

## 7. Protection des clés

Les clés cryptographiques constituent des actifs particulièrement sensibles.

Principes :

- Les clés privées ne sont jamais transmises au serveur en clair.
- Les clés locales sont protégées par les mécanismes natifs.
- Les clés de sauvegarde sont séparées des clés de communication.
- Les clés de session ne sont pas réutilisées arbitrairement.
- Les opérations de rotation et révocation sont authentifiées.
- Les secrets ne sont jamais écrits dans les logs.
- Les copies temporaires de clés doivent être limitées.

Le modèle exact de cycle de vie des clés sera documenté après sélection du protocole.

## 8. Protection des données au repos

### Sur les appareils

- Base locale chiffrée.
- Clés dans Keychain et Keystore.
- Caches protégés.
- Nettoyage des données temporaires.
- Pas de données privées en clair dans les logs.
- Nettoyage adapté à la déconnexion.

### Sur le serveur

- Chiffrement des disques et sauvegardes.
- Protection des secrets d'infrastructure.
- Contrôle des accès à PostgreSQL.
- Séparation des environnements.
- Protection des fichiers chiffrés.
- Journaux sans contenu privé.

Le chiffrement du disque ne remplace pas le chiffrement applicatif et le contrôle d'accès.

## 9. Sécurité applicative

L'application et le backend doivent également résister aux attaques classiques :

- Injection SQL.
- XSS dans les interfaces web futures.
- CSRF lorsque pertinent.
- SSRF.
- Contrôle d'accès défaillant.
- Élévation de privilèges.
- Mass assignment.
- Désérialisation dangereuse.
- Attaques par déni de service.
- Abus de ressources.
- Fuite de secrets.
- Dépendances vulnérables.

Les protections comprennent notamment :

- Validation des entrées.
- Autorisation systématique côté serveur.
- Requêtes paramétrées via Prisma.
- Limitation de débit.
- Contrôle des fichiers.
- Politique de sécurité adaptée.
- Gestion des dépendances.
- Tests de sécurité.
- Mise à jour régulière des composants.

La validation côté client ne remplace jamais la validation et l'autorisation côté serveur.

## 10. Journalisation et audit

Les journaux ne doivent jamais contenir :

- Mots de passe.
- Clés privées.
- Secrets de récupération.
- Contenus privés en clair.
- Tokens d'authentification.
- Données sensibles inutiles.

Les événements de sécurité doivent être enregistrés :

- Connexion.
- Échec d'authentification.
- Ajout d'appareil.
- Révocation.
- Récupération.
- Modification de paramètres sensibles.
- Opérations administratives.
- Accès aux dossiers de modération.

Les journaux doivent être protégés contre les modifications non autorisées.

Les durées de conservation restent à définir.

## 11. Risques résiduels et limites

Même avec une architecture correctement conçue, certains risques ne peuvent pas être entièrement éliminés.

### Appareil compromis

Un appareil compromis peut exposer les données accessibles à l'application.

### Destinataire malveillant

Un destinataire peut copier ou partager un contenu déchiffré.

### Métadonnées

Le chiffrement du contenu ne masque pas automatiquement les relations, horaires, volumes et informations de distribution.

### Sauvegardes

La perte de la phrase secrète peut rendre une sauvegarde définitivement inaccessible.

### Notifications

Les fournisseurs push peuvent observer certaines informations de distribution.

### Compromission de l'infrastructure

Un serveur compromis peut perturber les communications, modifier des métadonnées ou bloquer des comptes, même s'il ne peut pas déchiffrer les contenus protégés par un E2EE correctement implémenté.

Ces limites doivent être prises en compte dans les garanties annoncées aux utilisateurs.

## 12. Exigences de tests de sécurité

Avant une mise en production, il faudra notamment vérifier :

### Identités

- Création d'identité.
- Persistance.
- Redémarrage.
- Changement d'appareil.
- Restauration.
- Révocation.

### Communications

- Échange entre deux utilisateurs.
- Destinataire hors ligne.
- Reconnexion.
- Messages désordonnés.
- Rejeu.
- Prékeys épuisées.
- Changement de clés.
- Plusieurs appareils.

### Sauvegardes

- Sauvegarde initiale.
- Sauvegarde après modification.
- Restauration.
- Corruption.
- Mauvaise phrase secrète.
- Perte totale des appareils.
- Révocation des anciens appareils.

### Stockage

- Protection de la base locale.
- Protection des clés.
- Absence de contenu en clair dans les logs.
- Nettoyage après déconnexion.
- Protection des caches.

### Backend

- Accès non autorisés.
- Isolation des espaces.
- Vérification des permissions.
- Résistance aux abus.
- Protection des endpoints sensibles.

Les tests doivent être automatisés lorsque possible et conservés dans le dépôt.

## 13. Critères avant mise en production

Aucune implémentation cryptographique ne doit être considérée comme prête pour la production simplement parce que les tests fonctionnels passent.

La validation doit notamment inclure :

1. Revue du protocole et de son adéquation aux besoins.
2. Vérification des licences.
3. Analyse de la maintenance et de la maturité du SDK.
4. Vérification des vecteurs de tests officiels.
5. Tests d'interopérabilité.
6. Tests multi-appareils.
7. Tests de récupération.
8. Tests sur appareils iOS et Android.
9. Revue des risques de fuite de clés.
10. Audit indépendant avant une mise en production significative.

## 14. Décisions de sécurité encore ouvertes

Les points suivants doivent être résolus :

- Protocole cryptographique définitif.
- SDK cryptographique.
- Modèle de délégation des identités.
- Certification des appareils.
- Modèle de rotation des clés.
- Format de sauvegarde.
- Paramètres Argon2id.
- Algorithmes AEAD et gestion des nonces selon le protocole.
- Gestion des groupes et espaces partagés.
- Protection contre les appareils compromis.
- Stratégie de sécurité des notifications.
- Durées de conservation des journaux.
- Politique de réponse aux incidents.
- Processus d'audit externe.

## 15. Règle finale

La sécurité de Bunny Talks ne doit jamais être réduite à une fonctionnalité ou à une bibliothèque.

Elle constitue une propriété de l'ensemble du système :

- Architecture.
- Protocole.
- Implémentation.
- Stockage.
- Gestion des appareils.
- Backend.
- Notifications.
- Sauvegardes.
- Processus opérationnels.

Toute décision technique susceptible de modifier les garanties de sécurité doit être évaluée à l'aide de ce modèle de menaces et documentée.

**La confidentialité est une propriété fondamentale de Bunny Talks, pas une option ajoutée après le développement.**
