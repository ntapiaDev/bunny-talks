# Archive chiffrée, sauvegarde et récupération

**Projet :** Bunny Talks  
**Statut :** Décisions fonctionnelles validées — conception technique à vérifier  
**Priorité :** Exigence fondamentale de sécurité et de fiabilité

## 1. Objectif

Bunny Talks doit permettre à chaque utilisateur de conserver durablement ses communications privées et de les retrouver après un changement ou une perte d'appareil.

La perte d'un téléphone ne doit pas entraîner la perte des lettres, des conversations ou des brouillons de l'utilisateur.

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

Chaque utilisateur possède sa propre copie chiffrée des communications qu'il a envoyées ou reçues. La suppression d'une copie ne doit pas entraîner automatiquement la suppression de celle de l'autre correspondant.

## 3. Sauvegarde automatique

Le système doit proposer :

- Une sauvegarde automatique quotidienne lorsque des changements ont été effectués.
- Une sauvegarde manuelle à la demande.
- Une sauvegarde automatique des brouillons pendant leur rédaction.
- Une synchronisation chiffrée des brouillons entre appareils autorisés.
- La conservation de versions récentes des brouillons afin de permettre leur restauration après une modification accidentelle.
- Une indication visible de la date de la dernière sauvegarde réussie.

Les sauvegardes doivent être incrémentales lorsque cela est pertinent, avec des snapshots périodiques permettant une restauration efficace.

## 4. Architecture cryptographique

L'archive durable doit être indépendante des sessions de chiffrement utilisées pour transporter les messages.

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

Lorsqu'un utilisateur possède encore un appareil autorisé :

1. Il installe Bunny Talks sur son nouvel appareil.
2. Le nouvel appareil génère une demande d'association.
3. L'ancien appareil autorise l'association par QR code.
4. Un transfert cryptographique sécurisé établit les autorisations nécessaires.
5. Le nouvel appareil télécharge l'archive chiffrée.
6. Il restaure localement les données et crée ses propres sessions cryptographiques.

Le QR code ne doit jamais contenir directement de clé privée durable.

## 6. Récupération après perte de tous les appareils

La récupération ne doit pas nécessiter l'accès à un ancien appareil.

Un coffre de récupération chiffré est donc indispensable.

Parcours prévu :

1. L'utilisateur installe Bunny Talks sur un nouvel appareil.
2. Il s'authentifie avec son compte.
3. Il sélectionne « J'ai perdu mon ancien appareil ».
4. Il saisit son secret de récupération personnel, distinct du mot de passe du compte.
5. L'application télécharge le coffre chiffré.
6. Les clés de récupération sont retrouvées localement.
7. L'archive est téléchargée et déchiffrée sur le nouvel appareil.
8. L'identité cryptographique durable est restaurée selon le modèle validé.
9. Les anciennes sessions d'appareils sont révoquées autant que possible.
10. De nouvelles sessions cryptographiques sont établies.

Le secret de récupération doit être présenté à l'utilisateur lors de sa création, accompagné d'instructions claires pour le conserver en lieu sûr.

La récupération doit être testée avant de considérer un compte comme correctement protégé.

## 7. Gestion des appareils

Un compte peut posséder jusqu'à cinq appareils autorisés.

Tous les appareils appartiennent à une même identité de compte du point de vue de l'utilisateur, mais conservent leurs propres éléments cryptographiques locaux lorsque le protocole l'exige.

Fonctionnalités prévues :

- Liste des appareils autorisés.
- Identification du type d'appareil et de sa dernière activité.
- Révocation individuelle.
- Action « Révoquer tous les autres appareils ».
- Confirmation par le mot de passe du compte.
- Conservation de l'appareil courant lors d'une révocation globale.
- Notification de sécurité lors d'un ajout, d'une révocation ou d'une récupération.

La révocation empêche les accès futurs, mais ne peut pas effacer les données déjà copiées ou déchiffrées sur un appareil compromis.

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

En particulier :

- La suppression d'une lettre chez son expéditeur ne doit pas supprimer automatiquement la copie déjà reçue.
- La suppression d'un compte ne doit pas faire disparaître les lettres et messages conservés légitimement par les destinataires.
- Les données personnelles supprimées doivent être traitées conformément aux obligations légales applicables.
- Les sauvegardes doivent intégrer des mécanismes de suppression différée et de propagation des suppressions lorsque nécessaire.

Les durées de conservation et les règles exactes de suppression devront être définies dans la politique de confidentialité et les spécifications fonctionnelles.

## 10. Tests obligatoires

Avant validation de l'architecture, les scénarios suivants doivent être testés :

- Restauration complète sur un nouveau téléphone.
- Récupération après perte du dernier appareil.
- Restauration des lettres et de l'intégralité des chats.
- Restauration des pièces jointes.
- Récupération de l'identité cryptographique.
- Conservation des archives après rotation des clés de session.
- Sauvegarde interrompue par une perte réseau.
- Restauration après corruption de la base locale.
- Restauration après corruption d'une sauvegarde.
- Synchronisation de brouillons depuis plusieurs appareils.
- Révocation d'un appareil perdu.
- Ajout et révocation successifs d'appareils.
- Restauration d'une archive ancienne après plusieurs mois.
- Vérification de l'intégrité des données restaurées.

Les tests doivent être automatisés autant que possible et conservés dans les packages de production concernés.

## 11. Limites et transparence

Bunny Talks doit viser une conservation extrêmement fiable, mais ne doit pas promettre une récupération absolue dans toutes les circonstances.

Si tous les appareils, toutes les sauvegardes exploitables et le secret de récupération sont perdus, les données peuvent devenir irrécupérables.

Le système doit donc aider activement l'utilisateur à protéger son secret de récupération et à vérifier que ses sauvegardes sont opérationnelles.

## 12. Principe architectural fondamental

**Les sessions cryptographiques servent à communiquer. L'archive chiffrée sert à conserver.**

Ces deux responsabilités sont distinctes et doivent rester indépendantes.

Aucune décision concernant le SDK cryptographique, le stockage ou la synchronisation ne doit compromettre la capacité d'un utilisateur à retrouver durablement ses lettres, ses conversations et ses brouillons.
