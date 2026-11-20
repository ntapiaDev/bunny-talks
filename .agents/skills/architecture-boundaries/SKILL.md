---
name: architecture-boundaries
description: Concevoir, implémenter ou auditer les frontières entre modules NestJS, couches, adaptateurs ou packages de Bunny Talks lors d'une évolution structurante. Ne pas activer pour une correction locale ou un ajout dans une structure existante.
---

# Architecture boundaries — procédure ciblée

Appliquer une Clean Architecture **pragmatique**, adaptée au monolithe modulaire NestJS et aux packages réellement présents. Ce skill sert à prendre une décision de **frontière** ; il ne demande ni réarchitecture générale ni découpage systématique. Les règles permanentes et l'aiguillage documentaire relèvent d'`AGENTS.md`.

## 1. Délimiter la décision

1. Formuler ce qui change : responsabilité nouvelle, dépendance envisagée, contrat à exposer ou couplage observé.
2. Cartographier **seulement** les composants concernés : consommateurs, fournisseurs, importations effectives et sens des dépendances.
3. Identifier les contraintes existantes : invariants métier, contrats publics, transactions atomiques, autorisation, persistance, tests et compatibilité de l'API. Appliquer une décision existante, signaler toute contradiction constatée ou proposer explicitement son évolution ; ne pas la remplacer silencieusement.

## 2. Choisir la frontière minimale utile

- **Domaine** : règles et invariants sans dépendance à NestJS, Prisma, React Native ou aux détails d'un fournisseur.
- **Application** : orchestration des opérations, préconditions et coordination des capacités ; elle peut utiliser des fonctions pures sans exiger une classe ou un port supplémentaire.
- **Infrastructure** : PostgreSQL/Prisma, réseau, SDK et autres adaptateurs. Isoler les effets et les contrats de confiance lorsqu'une frontière est utile.
- **Présentation** : contrôleurs, guards, validation d'entrée et projection des réponses ; vérifier les contrats exposés et les responsabilités de cette couche.
- **Packages partagés** : uniquement pour une responsabilité autonome ou un véritable besoin de partage ; ne pas exposer de détails de framework dans un contrat commun.

Les couches sont des **responsabilités et directions de dépendance**, pas des dossiers obligatoires. Ne pas introduire une interface par classe, une factory pour chaque fonction ou un package par fonctionnalité.

## 3. Examiner les options

Pour un changement significatif, comparer brièvement :

- garder la responsabilité dans le module existant ;
- introduire une frontière locale (fonction, capacité étroite, port ou adaptateur) ;
- extraire un module ou package réellement indépendant.

Évaluer chaque option sur la cohésion, les dépendances, les garanties transactionnelles, la facilité de test et le coût de migration/maintenance. Favoriser **la plus petite structure qui protège les invariants**. Ne pas présenter le découplage comme un bien absolu : un composant transactionnel dépendant de PostgreSQL peut être justifié, à condition de ne pas le décrire comme un domaine pur.

## 4. Vérifier les conséquences

- S'assurer que les nouvelles dépendances vont dans le sens convenu et qu'aucune nouvelle frontière ne contourne les restrictions permanentes d'accès aux capacités privilégiées.
- Repérer les dépendances circulaires, duplications de logique, packages fourre-tout et services de composition cachés.
- Vérifier qu'un déplacement n'a pas cassé l'API publique, la sérialisation, les règles d'autorisation, les garanties atomiques ou les imports NodeNext.
- Choisir des tests de contrat et de comportement **aux frontières réellement modifiées**, sans lancer de refactorisation transversale non demandée.

## 5. Critère de fin spécialisé

La décision doit pouvoir être expliquée en termes de **responsabilité, sens des dépendances, alternative écartée et coût concret**. Si la structure actuelle suffit, conclure explicitement qu'aucune nouvelle abstraction n'est nécessaire. Ne pas déclarer une architecture « conforme » sur la seule présence de dossiers `domain/application/infrastructure`.

Si une **décision architecturale durable** change les responsabilités, les dépendances ou les contrats entre modules, proposer un nouvel ADR ou l'évolution de l'ADR pertinent, selon les conventions du dépôt. Distinguer décision proposée et décision approuvée ; ne pas créer d'ADR pour une réorganisation locale sans conséquence durable.
