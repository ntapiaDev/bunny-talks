# Bunny Talks — Instructions de développement

## Projet

Bunny Talks est une application sociale conçue d'abord pour le mobile, centrée sur les relations enrichissantes, la correspondance et les espaces partagés.

L'application n'est pas une plateforme de rencontres amoureuses.

## Langue

- Rédiger en français les instructions destinées à Codex et la documentation du projet.
- Rédiger en anglais le code source, les identifiants et les commentaires techniques.
- Communiquer avec le développeur et rédiger les rapports qui lui sont destinés en français.
- Rédiger les messages Conventional Commits en anglais.
- Respecter les conventions existantes du dépôt.

## Architecture

- Utiliser TypeScript avec une vérification stricte des types.
- Suivre les principes de la Clean Architecture.
- Garder la logique du domaine indépendante des frameworks et de l'infrastructure.
- Utiliser des packages réutilisables au sein du monorepo pnpm.
- Préférer des solutions simples et maintenables aux abstractions prématurées.
- Respecter les décisions architecturales et produit documentées.
- Ne pas modifier silencieusement une décision établie.

## Technologies

- Node.js 24 et pnpm 10.34.9.
- React Native et Expo Development Builds pour le mobile.
- NestJS, Prisma et PostgreSQL pour le backend.
- Vitest pour les tests automatisés.
- Ubuntu WSL comme environnement de développement.

## Cryptographie

La justesse cryptographique et la sécurité priment sur la vitesse.

- Ne jamais implémenter de primitives cryptographiques maison.
- Considérer OpenE2EE 14.5.0 comme un SDK en cours d'évaluation.
- Ne pas présumer de la compatibilité du SDK sans vérification.
- Examiner le code source installé et les déclarations TypeScript publiques.
- Préférer les API publiques documentées aux détails internes d'implémentation.
- Garder le code spécifique au SDK isolé de crypto-core.
- Ne jamais exposer de clés privées, de secrets de récupération ou de données sensibles en clair dans les logs.
- Ne jamais affaiblir les exigences de sécurité pour faire passer un test.
- Distinguer explicitement les comportements vérifiés des hypothèses.

Le modèle de compte visé comprend :

- Une identité cryptographique durable partagée entre les appareils de confiance.
- Des sessions et identifiants d'enregistrement propres à chaque appareil.
- L'association et la révocation sécurisées des appareils.
- Un historique chiffré accessible aux appareils nouvellement autorisés.
- Une récupération chiffrée indépendante après la perte de tous les appareils de confiance.

Ces exigences ne sont pas encore validées par rapport au SDK.

## Implémentation

- Toutes les expérimentations doivent produire du code réutilisable orienté production.
- Éviter les prototypes jetables et les implémentations dupliquées.
- Effectuer des modifications petites, cohérentes et faciles à examiner.
- Préserver le travail existant et les modifications non commitées.
- Ne pas installer de dépendances sans expliquer pourquoi.
- Ne pas introduire de changements incompatibles sans approbation explicite.
- Ne pas créer de commits sauf si cela est demandé.

## Qualité

### Organisation des imports TypeScript

Dans tous les fichiers TypeScript et TSX du monorepo, organiser les imports par groupes, dans cet ordre :

1. Modules natifs Node.js (`node:`).
2. Dépendances externes, y compris les packages npm avec scope.
3. Packages internes `@bunny-talks/*`.
4. Alias internes éventuels (`@/*`, etc.).
5. Imports relatifs, en privilégiant les chemins parents avant les chemins du dossier courant.

Trier alphabétiquement les imports au sein de chaque groupe, sans imposer de ligne vide entre les groupes, et utiliser `import type` pour les dépendances utilisées uniquement comme types. Préserver impérativement l'ordre des imports à effets de bord lorsque leur exécution en dépend. Respecter les conventions TypeScript NodeNext ESM, notamment les extensions `.js` nécessaires aux imports relatifs.

Lorsque cela est pertinent, exécuter :

- pnpm typecheck
- pnpm lint
- pnpm test
- pnpm format:check

Ajouter des tests automatisés pour les nouveaux comportements, y compris les cas d'échec.
Indiquer les vérifications exécutées et celles qui n'ont pas pu être effectuées.

## Git

- Utiliser les Conventional Commits.
- Recommander un message de commit approprié à chaque jalon cohérent.
- Ne jamais commiter de secrets, d'identifiants d'accès ou de données sensibles générées.
- Ne jamais abandonner ou écraser des modifications existantes sans approbation.

## Documentation

Consulter ces fichiers avant tout changement architectural important :

- docs/product/project-overview.md
- docs/architecture/architecture-overview.md
- docs/security/encrypted-archive-and-recovery.md
- docs/security/threat-model.md

Mettre à jour la documentation lorsque l'implémentation modifie un contrat technique établi ou introduit une décision architecturale importante.

## Rapport

À la fin de chaque tâche d'implémentation, résumer :

1. Les changements apportés.
2. Les fichiers concernés.
3. Les tests et vérifications réussis ou échoués.
4. Les risques ou questions restant en suspens.
5. Le message Conventional Commit suggéré, lorsque cela est approprié.

## Autonomie

Prendre en charge l'implémentation technique dans le périmètre des missions approuvées. Explorer le dépôt et les dépendances, concevoir les détails d'implémentation, créer et modifier les fichiers nécessaires, écrire et exécuter les tests, diagnostiquer et corriger les erreurs, effectuer de petites refactorisations justifiées et mettre à jour la documentation pertinente de manière autonome.

S'arrêter et demander une approbation avant :

- Un changement architectural important.
- Un changement fonctionnel non prévu.
- Un compromis de sécurité ou un changement des exigences de sécurité.
- L'introduction d'une dépendance sensible non approuvée.
- Un changement incompatible d'un contrat public.
- Une opération qui risque de détruire du travail existant.

Ne pas demander d'approbation pour chaque détail technique ordinaire.

## Contrôle Git — Obligatoire

Le développeur humain conserve le contrôle exclusif de la validation et de la publication du code. Ne jamais exécuter les commandes suivantes sans autorisation explicite :

- git add
- git commit
- git push
- git reset
- git rebase
- git merge
- git cherry-pick
- git clean
- Toute autre opération Git qui modifie l'historique, l'index ou les références.

Les commandes Git en lecture seule sont autorisées. À chaque jalon cohérent, recommander un message Conventional Commit, mais ne jamais créer le commit soi-même. Ne jamais publier de code ou de données sur un dépôt distant sans autorisation.

## Revue de code obligatoire

Laisser les modifications du jalon non commitées pour permettre leur revue. Présenter :

1. Les fichiers créés et modifiés.
2. Le comportement implémenté.
3. Les principales décisions techniques et leurs justifications.
4. Les alternatives significatives envisagées et les raisons pour lesquelles elles n'ont pas été retenues.
5. Les tests exécutés et leurs résultats.
6. Les risques, les limites et les travaux restants.
7. Les parties du code qui méritent une attention particulière pendant la revue.
8. Le message de commit recommandé.

Ne jamais affirmer qu'une fonctionnalité est validée si les tests correspondants n'ont pas été exécutés.

## Pédagogie

Expliquer les concepts importants, les choix techniques et les compromis afin que le développeur puisse comprendre et maîtriser le code. Privilégier les implémentations lisibles, explicites et maintenables, et ne pas ajouter de complexité uniquement pour démontrer des techniques avancées. Lorsqu'une décision est remise en question, fournir des arguments techniques, des exemples et, lorsque cela est utile, des tests. Signaler les nouvelles notions importantes sans donner d'explications élémentaires non sollicitées.

## Efficacité et utilisation des ressources

- Réutiliser les informations établies et éviter les recherches redondantes.
- Cibler les fichiers pertinents avant d'élargir l'exploration et regrouper les travaux liés.
- Exécuter d'abord les tests ciblés pendant le développement, puis les vérifications globales appropriées avant de présenter un jalon comme terminé.
- Garder les rapports concis et éviter les propositions architecturales inutiles.
- Ne jamais sacrifier les vérifications de sécurité pour économiser des ressources.

## Jalons

Travailler par jalons cohérents et faciles à examiner. Chaque jalon doit avoir un objectif clair, des critères d'acceptation, des tests appropriés, un résultat vérifiable et un point de revue avant commit. Poursuivre les tâches techniques nécessaires au sein d'un jalon, mais ne pas commencer automatiquement un nouveau jalon majeur sans approbation.
