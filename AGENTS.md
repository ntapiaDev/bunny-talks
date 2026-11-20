# Bunny Talks — Instructions permanentes pour Codex

## Produit et communication

Bunny Talks est une application sociale mobile centrée sur la correspondance, les relations réciproques et les espaces partagés. Ce n'est ni une application de rencontres amoureuses ni un réseau social fondé sur les abonnés. La confiance, la confidentialité et la conservation des échanges sont structurantes.

- Communiquer avec le développeur, rédiger la documentation et les rapports en français.
- Écrire les identifiants, le code et les commentaires techniques en anglais ; proposer les messages Conventional Commit en anglais.
- Pour les écrans destinés aux utilisateurs, respecter la stratégie de localisation FR/EN du produit : la langue du code ne détermine pas les textes affichés. Ne pas ajouter une infrastructure i18n hors périmètre.
- Respecter les conventions et contrats existants. Les manifests et configurations font foi pour les versions, les dépendances et les commandes disponibles.

## Contexte et documentation — point d'entrée unique

Consulter **uniquement** les sources utiles à la mission. Ne pas parcourir tous les documents ni reconstruire tout le projet par défaut.

- **Reprise ou clôture d'un jalon** : `docs/development/current-milestone.md`. `docs/development/milestone-history.md` sert à retrouver une étape passée, pas à déterminer l'état courant.
- **Produit / comportement attendu** : `docs/product/project-overview.md`.
- **Architecture / frontières de modules** : `docs/architecture/architecture-overview.md`, puis les ADR pertinents de `docs/architecture/decisions/`.
- **Sécurité / cryptographie / récupération** : `docs/security/threat-model.md`, puis les spécifications et rapports concernés dans `docs/security/` et `docs/development/`.
- **API / données / mobile / tests natifs** : code, configuration et rapports ciblés de `docs/development/`.

Le jalon courant décrit **l’état déclaré du pilotage**, pas une preuve indépendante du code exécuté. Pour un fait implémenté, examiner le code et les tests ; pour une exigence ou une décision, consulter la documentation qui la définit ; pour un niveau de qualification, vérifier la preuve et son périmètre. En cas de désaccord entre ces sources, **signaler l'écart** sans réinterpréter silencieusement une décision. Mettre à jour les documents touchés par un changement de contrat, une nouvelle décision ou une qualification ; ne pas réécrire l'historique pour l'aligner rétroactivement.

## Architecture et implémentation

- Utiliser TypeScript strict et les conventions effectivement imposées par ESLint, Prettier et TypeScript, notamment `import type`, les imports relatifs `.js` en NodeNext et l'ordre des imports à effets de bord.
- Appliquer une Clean Architecture **pragmatique** : domaine sans dépendance aux frameworks ou à l'infrastructure ; orchestration applicative et adaptateurs distincts lorsqu'une frontière utile existe ; contrôleurs sans accès direct aux clients Prisma, connexions SQL ou implémentations concrètes de persistance ; ils délèguent aux capacités applicatives adaptées.
- Ne pas créer automatiquement quatre dossiers par fonctionnalité, une interface par classe ou un nouveau package sans responsabilité distincte. Garder le backend NestJS modulaire et les packages partagés ciblés.
- Préférer des modifications limitées, lisibles et maintenables. Isoler les expérimentations et ne pas présenter un POC comme une capacité de production.

## Invariants de sécurité

- Aucun algorithme ou primitive cryptographique maison ; ne jamais assouplir une garantie de sécurité pour satisfaire un test.
- Préserver l'indépendance de `crypto-core` vis-à-vis du SDK. OpenE2EE reste **expérimental** ; ne pas confondre modèle cible, fonction implémentée, preuve expérimentale et aptitude à la production.
- Respecter les orientations retenues : identité cryptographique durable commune aux appareils de confiance, état et sessions propres aux appareils, gestion sûre des autorisations/révocations, historique privé récupérable et coffre déverrouillable via mot de passe ou clé de récupération indépendante. Leur réalisation complète et leur qualification ne sont pas acquises.
- Ne jamais exposer secrets, mots de passe, jetons, clés, URL de connexion ou contenus privés dans les sources, fixtures non protégées, logs, rapports, captures d’écran, traces réseau, dumps mémoire, artefacts de diagnostic ou échanges externes. Utiliser des valeurs factices et assainir les preuves conservées.
- Aucun identifiant ni secret réel sur le diagnostic HTTP local ou sur un transport mobile HTTPS dont les propriétés de sécurité pertinentes ne sont pas qualifiées. Refuser une intégration qui présume ces garanties à partir d'une simple API JavaScript.
- Contrôler authentification, autorisation et séparation des comptes/appareils aux frontières concernées. Un test Node, une compilation, un export Metro ou un succès sur émulateur ne prouvent ni la sûreté native ni la qualification iOS/release/production.

## Exécution et environnement

- Mener à terme la **mission autorisée** : changements nécessaires, tests ciblés, corrections des régressions introduites et documentation affectée. Ne pas étendre le périmètre à une initiative indépendante.
- Sélectionner d'abord les tests les plus discriminants et les moins coûteux ; élargir aux scripts de validation du dépôt seulement selon la portée et les risques. Inclure les cas d'échec pertinents ; ne pas relancer une campagne lourde lorsqu'une preuve existante reste applicable.
- Avant une opération susceptible d’altérer un **état persistant non jetable** ou un **environnement partagé**, identifier la cible et l’impact. Les écritures temporaires isolées et les tests ordinaires dans le périmètre autorisé ne nécessitent pas d’approbation supplémentaire. Préserver les bases PostgreSQL, volumes Docker, keystores et données d’émulateur ; demander une décision avant toute suppression, réinitialisation, écrasement, migration destructive ou intervention risquant les données existantes.
- Justifier les nouvelles dépendances et modifications d'environnement. Ne pas transmettre de données sensibles à des services externes.
- Ne pas annoncer de vérification ou de qualification qui n'a pas été exécutée ; préciser ce qui demeure non vérifié.

## Autonomie et jalons

- Trancher les détails techniques ordinaires dans le jalon demandé, sans approbations répétitives. Demander une décision avant un changement architectural ou fonctionnel majeur **hors périmètre**, une dégradation de sécurité, une dépendance sensible non approuvée, une rupture de contrat public ou une action destructrice.
- Terminer et soumettre chaque jalon à revue humaine avant de commencer le suivant. Les corrections issues de cette revue restent dans le jalon en cours. La clôture et l'acceptation des limites appartiennent au développeur.

## Git et restitution

- **Le développeur seul gère Git** : branches, index, commits et publication. N'exécuter **aucune commande Git**, même en lecture seule, sauf demande explicite. Ne pas demander de vérification de branche ou d'état Git par défaut. **Ne créer aucun commit.**
- À la fin d’un travail, commencer par un verdict clair : **prêt pour revue** (périmètre demandé réalisé, vérifications pertinentes effectuées, pas de blocage connu), **partiellement vérifié** (travail réalisé ou avancé, preuves encore incomplètes), ou **bloqué** (anomalie, dépendance ou décision empêchant l’achèvement). **Prêt pour revue ne signifie ni accepté, ni qualifié en sécurité, ni prêt pour production.** Résumer modifications, vérifications effectives et risques/limites. Pour les tâches sensibles, séparer preuves et hypothèses, anomalies **bloquantes** et **facultatives**, avec emplacements et éléments vérifiables.
- Proposer après **chaque travail**, y compris un jalon incomplet, un message Conventional Commit **indicatif** en anglais ; si aucun changement ne justifie encore un commit, le signaler. Ce message n’implique ni clôture du jalon ni recommandation de commiter immédiatement. Expliquer les décisions significatives de manière concise et pédagogique.
