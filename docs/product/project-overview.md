# Bunny Talks — Présentation générale et cahier des décisions

**Version : 1.0 — Novembre 2026**

---

# 1. Présentation du projet

## 1.1. Identité

**Nom du projet : Bunny Talks**

Bunny Talks est une plateforme de relations humaines, de correspondance et d'espaces partagés.

Ce n'est ni une application de rencontre amoureuse, ni un réseau social traditionnel centré sur les abonnés, les publications et la recherche de popularité.

L'ambition est de créer un environnement dans lequel les personnes peuvent se découvrir, nouer des relations sincères, entretenir des échanges dans la durée et partager des expériences ou des projets.

Le principe fondateur :

**« Créer des liens, partager des moments et construire des choses ensemble. »**

La conversation est le point de départ de la relation, pas sa finalité.

Bunny Talks doit être plus qu'une messagerie : un endroit où les relations peuvent évoluer et prendre différentes formes au fil du temps.

Positionnement anglais envisagé :

**More than conversations.**

## 1.2. Le symbole du lapin

Le lapin représente la communauté Bunny Talks.

Il constitue :

- Le symbole de la plateforme.
- L'identité visuelle principale.
- L'icône de l'application.
- Un élément reconnaissable de l'univers graphique.

Le lapin n'est pas un personnage interactif. Il n'est pas destiné à devenir un assistant virtuel ou un compagnon avec lequel l'utilisateur doit interagir.

Il représente la communauté dans son ensemble.

## 1.3. Philosophie du produit

Bunny Talks privilégie :

- La qualité des relations plutôt que le nombre de contacts.
- Les échanges sincères plutôt que les interactions superficielles.
- La découverte mutuelle plutôt que le défilement de profils.
- Les relations durables plutôt que la recherche permanente de nouvelles interactions.
- Le partage et les expériences communes plutôt que la simple accumulation de messages.

L'objectif n'est pas de maximiser artificiellement le temps passé dans l'application ou le nombre de contacts.

L'objectif est de construire une communauté active, accueillante et de qualité.

---

# 2. Les trois grands piliers fonctionnels

L'application s'articule autour de trois grandes dimensions.

## 2.1. Découvrir

La découverte permet de rencontrer de nouvelles personnes et de trouver des profils avec lesquels une relation pourrait se construire.

Fonctionnalités retenues :

- Recherche de profils par pseudonyme.
- Recherche par centres d'intérêt.
- Découverte de personnes partageant des passions ou des affinités.
- Profils publics ou privés.
- Visibilité contrôlée par l'utilisateur.
- Informations sur les langues parlées ou comprises.
- Possibilité d'envoyer une demande de contact.
- Présentation personnalisée accompagnant chaque demande.

Bunny Talks ne repose pas sur un système de swipe.

La découverte doit encourager une démarche volontaire : trouver une personne, prendre connaissance de son profil et décider de lui adresser une demande.

### Profils

Décisions :

- Chaque utilisateur dispose d'un pseudonyme.
- Le prénom est facultatif.
- Le profil peut être public ou privé.
- L'utilisateur contrôle sa visibilité.
- Les centres d'intérêt participent à la découverte.
- Les langues maîtrisées peuvent servir de critères de recherche.

Les champs exacts du profil et les règles détaillées de visibilité restent à définir.

## 2.2. Correspondre

La correspondance est le cœur historique et fonctionnel de Bunny Talks.

Plusieurs modes de communication coexistent.

### Lettres

Les lettres sont conçues pour des échanges plus construits et personnels.

Caractéristiques retenues :

- Communication privée de bout en bout.
- Conservation de l'historique.
- Possibilité de modifier brièvement une lettre après son envoi.
- Historique distinct des conversations instantanées.

L'objectif est de préserver une dimension plus personnelle et réfléchie de la communication.

### Chat

La messagerie instantanée permet les échanges rapides.

Caractéristiques :

- Messages privés chiffrés de bout en bout.
- Échanges entre contacts acceptés.
- Historique conservé selon les règles de rétention choisies.
- Synchronisation entre appareils.
- Statuts d'envoi, de distribution et de lecture.
- Notifications adaptées aux préférences de l'utilisateur.

### Notes éphémères

Les notes constituent un mode de communication plus spontané.

Décision :

- Les notes expirent après 24 heures.

Elles sont distinctes des lettres et du chat.

Leur expiration doit être effective dans le fonctionnement du système, et pas simplement masquer le contenu dans l'interface.

### Médias

Les communications privées peuvent inclure des photos et autres médias.

Décisions :

- Chiffrement local avant envoi.
- Clé du média transmise dans le message chiffré.
- Suppression des métadonnées EXIF et GPS.
- Miniatures également chiffrées.
- Pas d'URL publique permettant d'accéder directement aux fichiers.

Les formats, limites de taille et règles de conservation restent à préciser.

### Organisation des communications

Les lettres, notes et conversations instantanées restent des canaux distincts.

Une boîte de réception globale peut agréger les événements et activités, mais ne doit pas fusionner les historiques de ces différents canaux.

---

# 3. Les relations et les contacts

## 3.1. Fonctionnement des contacts

Bunny Talks utilise un modèle de relations mutuelles.

Décisions :

- Pas de système d'abonnement unilatéral.
- Pas de followers.
- Une relation devient effective après acceptation d'une demande de contact.
- Une demande peut être accompagnée d'une courte présentation.
- L'acceptation crée un espace partagé entre les deux personnes.

## 3.2. Espaces partagés

Chaque relation dispose d'un espace partagé unique.

Principes :

- Un espace par relation.
- L'espace appartient fonctionnellement aux deux participants.
- Il constitue le lieu de leurs interactions communes.
- Il peut accueillir différents modules.
- Les modules peuvent être activés selon les besoins de la relation.

L'espace partagé est une dimension fondamentale de Bunny Talks.

Il doit permettre aux relations de dépasser la simple conversation et de développer des activités communes.

## 3.3. Fin d'une relation

Décision retenue :

Lorsqu'une relation prend fin :

- Les communications futures sont interrompues.
- L'espace partagé cesse d'être un espace d'interaction commun.
- Chaque participant conserve une copie privée de son historique.
- L'ancien contact ne peut plus communiquer par l'intermédiaire de cette relation.

Le détail du traitement des modules partagés et des contenus appartenant collectivement aux deux participants reste à préciser.

## 3.4. Blocage

Le blocage est une mesure immédiate de protection.

Il entraîne :

- L'impossibilité d'envoyer des messages.
- L'impossibilité d'envoyer des demandes de contact.
- L'impossibilité d'inviter ou d'interagir.
- L'invisibilité mutuelle dans la découverte.
- L'absence de notification à la personne bloquée.

Le déblocage ne restaure pas automatiquement une ancienne relation.

---

# 4. Les espaces partagés et leurs modules

## 4.1. Vision

Les espaces partagés constituent l'une des caractéristiques différenciantes de Bunny Talks.

Ils ne doivent pas être de simples extensions de la messagerie.

Ils doivent permettre aux personnes de construire une histoire commune, de partager des activités, d'organiser des projets et de conserver des souvenirs.

Les modules envisagés comprennent notamment :

- Listes partagées.
- Films et séries à découvrir ou regarder.
- Voyages et projets de voyage.
- Cartes et lieux à visiter.
- Souvenirs communs.
- Calendrier partagé.
- Activités et tâches.
- Jeux.
- Journal partagé.
- Listes de souhaits.
- Autres outils de collaboration.

Cette liste constitue le périmètre fonctionnel envisagé, mais ne signifie pas que tous les modules seront disponibles dans la première version.

## 4.2. Architecture fonctionnelle

Décisions d'orientation :

- Les modules sont rattachés à un espace partagé.
- Ils peuvent être activés selon les besoins.
- Ils enrichissent la relation sans remplacer les conversations.
- Ils doivent pouvoir évoluer indépendamment les uns des autres.

L'architecture doit permettre d'ajouter de nouveaux modules sans remettre en cause le fonctionnement central des relations.

---

# 5. Modèle économique

## 5.1. Principe fondamental

La communication essentielle doit rester gratuite à vie.

Décisions :

- Pas de quotas artificiels de messages entre contacts acceptés.
- Pas de limitation artificielle du nombre de lettres.
- Les fonctionnalités essentielles de communication ne doivent pas être conditionnées à un abonnement.

## 5.2. Monétisation envisagée

Deux axes ont été retenus :

1. Achat de modules ou fonctionnalités complémentaires.
2. Abonnement donnant accès à des avantages ou fonctionnalités supplémentaires.

Le modèle exact reste à construire.

Il faudra notamment définir :

- Quels modules sont gratuits.
- Quels modules sont payants.
- Si un module acheté appartient à un utilisateur ou à un espace partagé.
- Comment les avantages d'un abonnement sont appliqués dans une relation entre deux personnes.
- Comment préserver l'équité entre utilisateurs payants et gratuits.

La monétisation ne doit pas dégrader artificiellement les relations ou les possibilités de communication.

---

# 6. Plateformes et utilisateurs

## 6.1. Plateformes

Décision :

- iOS et Android en priorité.
- Version web pour ordinateur dans un second temps.

La version web sera notamment adaptée à la correspondance et aux échanges écrits.

## 6.2. Âge

Décision pour la V1 :

- Application réservée aux personnes de 18 ans et plus.
- Déclaration de l'âge à l'inscription.
- Vérification complémentaire progressive en cas de risque objectif.
- Pas de collecte systématique de copies de pièces d'identité.
- Pas de bannissement automatique sans vérification appropriée.

---

# 7. Modération et sécurité communautaire

La modération a été conçue pour protéger la communauté sans introduire une surveillance généralisée des conversations privées.

## 7.1. Signalements

Les utilisateurs peuvent signaler :

- Un profil.
- Un message.
- Une lettre.
- Un média.
- Un comportement.
- Un contenu ou une activité dans un espace partagé.

Principes :

- Un signalement ne provoque pas automatiquement une sanction.
- Une décision humaine est nécessaire.
- Des mesures techniques temporaires de protection peuvent être appliquées immédiatement.
- Le signalement est confidentiel.
- L'auteur du signalement n'est pas révélé à la personne concernée.

## 7.2. Regroupement des signalements

Décision :

- Plusieurs signalements peuvent être regroupés dans un même dossier.
- Chaque signalement conserve son auteur, son motif, ses preuves et son suivi.
- Le regroupement est validé par un modérateur.
- Un signalement ne peut appartenir qu'à un seul dossier actif.

## 7.3. Gestion des dossiers

Statuts retenus :

- `NEW`
- `IN_PROGRESS`
- `WAITING`
- `DECISION_MADE`

Priorités :

- Critical
- High
- Normal
- Low

Les cas critiques comprennent notamment les menaces graves, l'exploitation de mineurs et les images intimes non consenties.

## 7.4. Preuves

Décision :

- Le signalement porte sur un élément sélectionné et un contexte limité.
- Des messages environnants peuvent être ajoutés.
- L'utilisateur visualise précisément ce qui sera transmis avant l'envoi.
- Des éléments complémentaires peuvent être ajoutés tant que le dossier est ouvert.
- Chaque ajout est horodaté et enregistré.
- Après clôture, le dossier ne peut plus être modifié ; un nouvel événement peut créer un nouveau signalement référencé à l'ancien.

Il n'existe pas d'accès global du serveur aux conversations chiffrées de bout en bout.

## 7.5. Mesures de protection

Le blocage est immédiat.

Des mesures automatiques limitées peuvent également intervenir :

- Limitation temporaire de certaines fonctionnalités.
- Protection contre le spam.
- Détection de comportements automatisés.
- Limitation des demandes répétitives.
- Restrictions adaptées aux nouveaux comptes.
- Détection de diffusion massive de liens.

Ces mesures sont proportionnées, limitées dans le temps, journalisées et ne constituent pas une décision automatique de culpabilité.

## 7.6. Sanctions

Sanctions retenues :

- Avertissement.
- Restriction de fonctionnalités.
- Suspension temporaire.
- Bannissement définitif.

Durées possibles :

- 24 heures.
- 72 heures.
- 7 jours.
- 30 jours.
- Définitif.

Un avertissement ne possède pas de durée.

Une sanction principale peut être accompagnée de mesures complémentaires sur les contenus.

Les sanctions multiples sont indépendantes et ne s'empilent pas automatiquement dans le temps.

## 7.7. Décision et recours

Décision validée :

- Un seul modérateur peut décider de toutes les sanctions, y compris un bannissement définitif.
- Il n'existe pas de procédure de recours interne dans la conception retenue.
- Les droits légaux de l'utilisateur restent naturellement applicables.
- En cas de conflit d'intérêts, un administrateur reprend le dossier et retire l'accès du modérateur concerné.

## 7.8. Communication de modération

Un canal officiel dédié permet de communiquer avec les utilisateurs.

Il est distinct des conversations privées et conserve les échanges liés au dossier.

Les modérateurs n'utilisent pas de comptes personnels pour ces communications.

L'utilisateur peut répondre, mais l'absence de réponse n'est jamais considérée comme une preuve de culpabilité.

## 7.9. Information des utilisateurs

L'utilisateur peut suivre l'état de son signalement.

Il reçoit des informations générales sur son traitement et son résultat, mais pas nécessairement les détails d'une sanction ou l'identité d'un autre utilisateur.

Délais indicatifs retenus :

| Priorité |   Première revue |        Résolution |
| -------- | ---------------: | ----------------: |
| Critical |     Moins de 2 h |     Moins de 24 h |
| High     |    Moins de 24 h |     Moins de 72 h |
| Normal   |    Moins de 72 h |  Moins de 7 jours |
| Low      | Moins de 7 jours | Moins de 15 jours |

## 7.10. Conservation des preuves

Principes définis :

- Signalement sans sanction : suppression des preuves 30 jours après clôture.
- Historique des sanctions : conservation pendant 12 mois.
- Les preuves nécessaires à une sanction doivent avoir une durée de conservation définie et justifiée, en tenant compte des obligations légales.

Un journal d'audit append-only conserve les événements de modération.

---

# 8. Internationalisation

L'architecture doit être multilingue dès le départ.

## 8.1. Langues de lancement

Décision :

- Français.
- Anglais.

## 8.2. Langue de l'interface

Principes :

- Détection initiale de la langue de l'appareil.
- Possibilité de choisir manuellement une langue.
- Synchronisation de la langue préférée entre les appareils.
- Langue de repli prévue.

## 8.3. Langue des contenus

La langue de l'interface est indépendante de la langue utilisée par les membres.

Les contenus créés par les utilisateurs ne sont pas traduits automatiquement sans leur consentement.

## 8.4. Langues des utilisateurs

Les utilisateurs peuvent déclarer les langues qu'ils parlent ou comprennent.

Ces informations peuvent servir aux critères de découverte.

Une liste de langues et un niveau de maîtrise pourront être associés à chaque langue.

---

# 9. Notifications

## 9.1. Catégories

Les préférences sont organisées par catégorie et par relation.

Catégories prévues :

- Lettres.
- Chat.
- Notes.
- Demandes de contact.
- Activités des espaces partagés.
- Alertes de sécurité.

Les alertes de sécurité sont traitées séparément des préférences ordinaires.

## 9.2. Préférences

Décisions :

- Accusés de lecture activés par défaut.
- Possibilité de désactiver les accusés de lecture.
- Heures silencieuses désactivées par défaut, mais configurables.
- Prévisualisation globale des notifications réglée sur le contenu complet par défaut.

Trois niveaux de prévisualisation :

1. Contenu complet.
2. Expéditeur et catégorie.
3. Aucune prévisualisation.

## 9.3. Comportement

- Notifications sur plusieurs appareils.
- Pas de notification sur l'appareil qui consulte déjà la conversation.
- Synchronisation des lectures entre appareils.
- Mise à jour ou suppression des notifications sur les autres appareils.
- Regroupement des messages rapprochés d'une même conversation.
- Lettres et notes notifiées immédiatement.
- Le regroupement ne doit pas retarder la livraison.
- Les heures silencieuses ne doivent pas provoquer une avalanche de notifications à leur fin.

## 9.4. Sécurité

Décisions :

- Notifications chiffrées de bout en bout sous forme d'enveloppes.
- Déchiffrement local sur l'appareil.
- Message générique de remplacement si le déchiffrement échoue.
- APNs sur iOS et FCM sur Android.
- Alertes de sécurité lors de l'ajout ou de la révocation d'un appareil et lors d'une récupération de compte.
- Langue des notifications conforme à la langue préférée.

Les statuts de message sont :

- Envoyé : reçu par le serveur.
- Distribué : reçu par un appareil du destinataire.
- Lu : ouvert par le destinataire.

Les accusés de lecture sont des événements authentifiés dans le système E2EE.

---

# 10. Architecture de sécurité et cryptographie

La confidentialité des communications est un principe central du produit.

## 10.1. Chiffrement de bout en bout

Les communications privées suivantes doivent être chiffrées de bout en bout :

- Lettres.
- Chat.
- Notes éphémères.
- Médias privés.

Le serveur ne doit pas disposer des clés permettant de lire les conversations.

Les données visibles par le serveur sont limitées aux informations nécessaires au fonctionnement, à la distribution et à la gestion des comptes.

Le chiffrement de bout en bout ne masque pas automatiquement toutes les métadonnées : les relations entre comptes, les horaires, les volumes et certaines informations de routage peuvent rester visibles.

## 10.2. Identités cryptographiques

Trois concepts ont été distingués :

**AccountIdentity**

- Identité cryptographique durable du compte.
- Doit survivre au remplacement ou à la perte des appareils.
- Sa récupération doit être possible à partir du mécanisme de sauvegarde prévu.

**DeviceIdentity**

- Identité cryptographique propre à chaque appareil.
- Chaque appareil possède ses propres clés.
- Les appareils peuvent être ajoutés ou révoqués indépendamment.

**CryptoSession**

- Session cryptographique entre deux appareils précis.
- Plusieurs sessions peuvent exister entre deux utilisateurs lorsqu'ils possèdent plusieurs appareils.

Le modèle exact des clés de signature, de délégation et de certification reste à confirmer avec le protocole retenu.

## 10.3. Multi-appareils

Décisions :

- Nombre d'appareils non limité artificiellement.
- Chaque appareil possède ses propres clés.
- Ajout d'un appareil approuvé depuis un appareil existant.
- Approbation cryptographique par QR code.
- Notifications de sécurité lors de l'ajout ou de la révocation.
- Révocation empêchant les accès futurs.
- Reconnaissance du fait que la révocation ne peut pas effacer les données déjà déchiffrées ou copiées.

Le QR code ne doit jamais contenir de clé privée en clair.

Il sert à établir un processus d'association sécurisé entre appareils.

## 10.4. Sauvegarde cryptographique

Décisions :

- Sauvegarde quotidienne automatique lorsque des données ont changé.
- Sauvegarde manuelle possible.
- Sauvegarde chiffrée dans un coffre.
- Phrase secrète personnelle distincte du mot de passe du compte.
- Récupération de compte par e-mail, mais récupération cryptographique indépendante.

Modèle envisagé :

- Argon2id pour dériver une clé à partir de la phrase secrète.
- Sel unique.
- Clé de chiffrement aléatoire de 256 bits.
- Clé de chiffrement des données protégée par une clé de chiffrement dérivée.
- Chiffrement authentifié AEAD avec nonces uniques.
- Changement de phrase secrète permettant de ré-envelopper la clé de données sans nécessairement rechiffrer toute l'archive.

Le format exact et les paramètres cryptographiques devront être validés avec la bibliothèque choisie.

## 10.5. Contenu des sauvegardes

Éléments à sauvegarder :

- Identité cryptographique durable.
- Lettres.
- Historique des conversations conservées.
- Médias sauvegardés.
- Préférences nécessaires à la restauration.

Éléments exclus :

- Notes déjà expirées.
- Clés éphémères déjà consommées.
- Sessions actives, qui seront recréées après restauration.

Le système doit gérer les suppressions par tombstones et prendre en charge les sauvegardes initiales puis, à terme, incrémentales.

Les transferts de sauvegarde doivent suivre un processus temporaire puis de validation définitive.

L'utilisateur doit pouvoir consulter la date de sa dernière sauvegarde.

## 10.6. Perte de tous les appareils

Le mécanisme de récupération doit permettre :

- La restauration du coffre cryptographique.
- La récupération de l'identité durable.
- La création de nouvelles identités d'appareil.
- La révocation des anciens appareils.
- L'information des contacts lorsque la sécurité de l'identité l'exige.

L'e-mail seul ne suffit pas à restaurer les clés.

## 10.7. Stockage local

Décisions :

- Base locale chiffrée.
- Clés protégées par iOS Keychain et Android Keystore.
- Caches temporaires protégés.
- Pas de contenu en clair dans les journaux.
- Pas de conservation permanente de données privées en clair après déconnexion.

## 10.8. Bibliothèque cryptographique

Aucune bibliothèque de production n'a encore été définitivement choisie.

Pistes étudiées :

- OpenE2EE Signal Protocol SDK.
- Bibliothèque officielle Signal `libsignal`.
- Éventuellement OpenMLS pour les besoins futurs de communication de groupe.

OpenE2EE est un candidat de laboratoire, pas une dépendance de production validée.

Points de vigilance :

- Absence d'audit indépendant public identifié.
- Communauté publique limitée.
- Implémentation TypeScript non officiellement affiliée à Signal.
- Absence d'interopérabilité garantie avec Signal Messenger.
- Nécessité de construire notre propre intégration serveur.
- Gestion de la restauration et du transfert des historiques à notre charge.

`libsignal` est une référence technique importante, mais sa licence AGPL-3.0 et son intégration native dans React Native nécessitent une étude juridique et technique.

Aucun algorithme cryptographique maison ne sera développé.

---

# 11. Architecture technique générale

## 11.1. Principes

Architecture retenue :

- Monolithe modulaire.
- Organisation par fonctionnalités.
- Clean Architecture.
- Séparation stricte du domaine et de l'infrastructure.
- Pas de microservices prématurés.
- Pas de Kubernetes au lancement.

## 11.2. Backend

Choix :

- NestJS.
- Prisma.
- PostgreSQL.
- Redis uniquement lorsque le besoin est établi.

PostgreSQL est la source de vérité.

Redis pourra intervenir ultérieurement pour :

- Présence.
- Cache.
- Limitation de débit.
- Files de traitement.
- Autres besoins de performance.

## 11.3. Application mobile

Choix :

- React Native.
- TypeScript.
- Expo.
- Development Builds.

Expo Go ne sera pas utilisé comme environnement de référence pour les intégrations cryptographiques natives.

## 11.4. Monorepo

Choix :

- pnpm Workspaces.
- Organisation `apps/` et `packages/`.
- Turborepo éventuellement plus tard, mais pas nécessaire au démarrage.

## 11.5. Clean Architecture

Les couches sont séparées ainsi :

**Domain**

- Entités.
- Value Objects.
- Règles métier.
- Contrats des repositories.

Le domaine ne dépend ni de NestJS, ni de Prisma, ni de Redis.

**Application**

- Cas d'utilisation.
- Ports.
- DTO.
- Orchestration des opérations.

**Infrastructure**

- Prisma.
- Redis.
- Adaptateurs externes.
- Implémentations techniques.

**Presentation**

- Contrôleurs HTTP.
- Gateways WebSocket.
- Guards.
- Présentation des données.

Les entités internes du domaine ne doivent pas être exposées directement aux clients.

Les clients partagent des contrats d'API et des schémas de validation, pas les objets internes du domaine.

---

# 12. Organisation du dépôt

Chemin du projet :

`/home/nicolas/bunny-talks`

Structure cible :

```text
bunny-talks/
├── apps/
│   ├── api/
│   ├── mobile/
│   ├── crypto-lab/
│   └── web/                 # plus tard
│
├── packages/
│   ├── contracts/
│   ├── validation/
│   ├── config/              # reporté jusqu'à un besoin réel
│   └── crypto/
│       ├── core/
│       ├── engine/
│       ├── storage/
│       ├── backup/
│       └── devices/
│
├── docs/
│   ├── product/
│   ├── architecture/
│   │   └── decisions/
│   ├── security/
│   └── development/
│
├── eslint.config.mjs
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.node.json
├── tsconfig.bundler.json
├── .prettierrc.json
└── .gitignore
```

Les packages ne doivent pas être créés uniquement pour remplir cette arborescence. Ils seront initialisés au moment où leur responsabilité devient concrète.

---

# 13. Outils et environnement de développement

## 13.1. Environnement

Décisions et installations réalisées :

- Windows avec Ubuntu sous WSL2.
- VS Code connecté à WSL.
- Dépôt situé dans le système de fichiers Linux.
- Node.js 24 LTS.
- pnpm 10.34.9.
- Git.
- TypeScript 6.0.3.

## 13.2. Qualité du code

Outils retenus :

- TypeScript strict.
- Prettier.
- ESLint avec Flat Config.
- Vitest pour les packages et le backend.
- Jest avec jest-expo envisagé pour les tests spécifiques au mobile.
- Playwright envisagé pour les tests de bout en bout web.

Les tests cryptographiques devront également inclure des vecteurs de tests de protocoles, des tests d'interopérabilité et des tests sur appareils réels.

## 13.3. Configuration TypeScript

Configuration commune stricte, notamment :

- `strict`
- `noImplicitOverride`
- `noImplicitReturns`
- `noFallthroughCasesInSwitch`
- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `forceConsistentCasingInFileNames`

Deux configurations spécialisées :

- NodeNext pour les packages exécutés sous Node.js.
- Bundler pour les applications utilisant un bundler, notamment Expo.

## 13.4. Git

Convention de commits retenue :

| Préfixe     | Usage           |
| ----------- | --------------- |
| `feat:`     | Fonctionnalité  |
| `fix:`      | Correction      |
| `refactor:` | Restructuration |
| `test:`     | Tests           |
| `docs:`     | Documentation   |
| `chore:`    | Maintenance     |
| `security:` | Sécurité        |

Les commits sont effectués après chaque étape cohérente et vérifiée, pas après chaque petite modification.

Une CI GitHub Actions est prévue.

---

# 14. Packages partagés

## 14.1. Contracts

Package : `@bunny-talks/contracts`

Responsabilité :

- Types partagés.
- Contrats des requêtes et réponses.
- Événements temps réel.
- Structures de notifications.
- Formats d'échange.

Il ne contient pas les entités métier internes ni les modèles Prisma.

## 14.2. Validation

Package : `@bunny-talks/validation`

Responsabilité :

- Schémas Zod.
- Validation des données partagées.
- Types dérivés des schémas.

Les règles de validation technique sont séparées des règles métier.

Zod est retenu pour la validation partagée entre backend et mobile.

## 14.3. Config

Le package `config` a été reporté.

Les configurations techniques sont déjà centralisées à la racine.

Les configurations applicatives et secrets doivent rester propres à chaque application.

Un package partagé ne sera créé que si un besoin réel le justifie.

## 14.4. Crypto

Organisation prévue :

- `core` : modèle cryptographique indépendant.
- `engine` : intégration du protocole et moteur cryptographique.
- `storage` : stockage local sécurisé.
- `backup` : sauvegarde et restauration.
- `devices` : gestion des appareils et associations.

`crypto-lab` est un banc d'essai et de démonstration. Il ne doit pas contenir de code de production jetable.

Toute implémentation réutilisable doit être placée dès le départ dans les packages appropriés.

---

# 15. Principes de développement non négociables

Les règles suivantes guident l'ensemble du projet.

1. Pas de prototype jetable : tout travail technique doit être conçu pour être réutilisable.
2. Pas de cryptographie maison : utiliser des protocoles et bibliothèques éprouvés.
3. Pas de dépendance entre le domaine métier et les frameworks techniques.
4. Pas d'accès serveur global aux conversations privées.
5. Pas de secrets serveur dans l'application mobile.
6. Pas de duplication inutile des contrats et validations.
7. Pas de microservices prématurés.
8. Pas de fonctionnalités créées uniquement pour augmenter artificiellement l'engagement.
9. Pas de quotas artificiels sur les communications essentielles.
10. La sécurité, la confidentialité et la qualité des relations doivent guider les décisions techniques.

---

# 16. Points restant à définir

Ce document ne signifie pas que tous les détails de Bunny Talks sont déjà arrêtés.

Voici les principaux sujets encore ouverts.

## Produit et expérience

- Parcours détaillé d'inscription.
- Méthodes exactes d'authentification.
- Structure complète des profils.
- Règles détaillées de visibilité.
- Algorithme et classement de découverte.
- Limites et règles des demandes de contact.
- Fonctionnement détaillé de chaque module partagé.
- Périmètre exact de la V1.
- Design et identité graphique complète.
- Accessibilité et ergonomie.
- Fonctionnement détaillé de la version web.

## Modération et juridique

- Politique définitive de conservation des preuves de sanction.
- Conditions générales d'utilisation.
- Politique de confidentialité.
- Processus de conformité réglementaire.
- Modalités précises de vérification d'âge.
- Obligations liées au signalement et au traitement des contenus illicites.

## Sécurité et cryptographie

- Choix définitif du protocole.
- Choix définitif du SDK cryptographique.
- Modèle précis de délégation et de certification des appareils.
- Format des sauvegardes.
- Paramètres cryptographiques définitifs.
- Gestion des changements et rotations de clés.
- Modèle de sécurité contre la compromission d'un appareil.
- Transfert et restauration des sessions.
- Tests d'interopérabilité.
- Audit indépendant.

## Architecture et exploitation

- Modèle de données PostgreSQL.
- Organisation exacte des modules NestJS.
- Stratégie WebSocket.
- Gestion des fichiers et stockage média.
- Hébergement et infrastructure.
- Observabilité.
- Sauvegardes serveur.
- CI/CD et déploiement.
- Gestion des erreurs et stratégie de disponibilité.

## Économie

- Détail des fonctionnalités payantes.
- Prix.
- Abonnements.
- Propriété et partage des modules achetés.
- Équilibre entre gratuit et payant.

---

# 17. Vision finale

Bunny Talks doit devenir une plateforme dans laquelle une personne peut :

1. Découvrir une autre personne avec laquelle elle partage des intérêts ou des affinités.
2. Lui envoyer une demande de contact personnalisée.
3. Construire une relation mutuelle après acceptation.
4. Échanger des lettres, des messages instantanés, des notes et des médias en toute confidentialité.
5. Disposer d'un espace partagé unique avec cette personne.
6. Utiliser des modules pour partager des souvenirs, organiser des activités et construire des projets.
7. Entretenir cette relation dans le temps, sans pression liée aux statistiques, aux quotas ou aux mécanismes artificiels d'engagement.

Le lapin symbolise cette communauté.

La conversation en est le point de départ.

Les relations, les expériences et les projets partagés en constituent la véritable finalité.

**Bunny Talks — More than conversations.**
