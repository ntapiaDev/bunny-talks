# Bunny Talks

Bunny Talks est une application sociale mobile consacrée à la correspondance, aux relations durables et aux espaces partagés. Elle n'est pas une application de rencontres amoureuses. Le projet est en développement ; les diagnostics cryptographiques restent expérimentaux et ne constituent pas une validation de production.

## Organisation

Le monorepo pnpm contient `apps/mobile` (Expo/React Native), `apps/api` (NestJS, Prisma et PostgreSQL) et des packages partagés : contrats, validation et composants cryptographiques `core`, `engine` et `backup`. Voir [l'architecture](docs/architecture/architecture-overview.md), [le mobile](docs/development/mobile-architecture.md) et [l'index documentaire](docs/README.md).

## Prérequis et démarrage local

Node.js 24.7 ou supérieur dans la branche 24, pnpm 10.34.9, Docker Compose pour PostgreSQL et, pour Android, un environnement Expo Development Build compatible. Depuis la racine :

```sh
pnpm install
pnpm --filter @bunny-talks/api prisma:generate
pnpm -r --if-present build
```

Pour l'API, préparer `apps/api/.env` à partir de [l'exemple](apps/api/.env.example), avec des secrets locaux distincts, puis suivre les [instructions PostgreSQL](docs/development/postgresql-prisma-foundation.md). Les migrations ne doivent être appliquées qu'après vérification de la destination et des SQL en attente :

```sh
pnpm db:up
pnpm --filter @bunny-talks/api prisma:generate
pnpm --filter @bunny-talks/api prisma:migrate
pnpm --filter @bunny-talks/api dev
```

Pour le mobile, utiliser le Development Build existant et `pnpm --filter @bunny-talks/mobile start`. Les dépendances ou plugins natifs modifiés peuvent nécessiter une reconstruction ; voir les [prérequis et limites de qualification](docs/development/mobile-qualification-prerequisites.md).

## Vérifications

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

`pnpm test` exécute les suites des packages et du mobile ainsi que les tests unitaires de l'API ; il ne lance pas les tests API de persistance ni les tests HTTP réels. Ces derniers sont respectivement `pnpm --filter @bunny-talks/api test:persistence` et `pnpm --filter @bunny-talks/api test:http`. Ils exigent une base de test PostgreSQL dédiée et les contrôles d'identité et de permissions décrits dans les [instructions de test](docs/development/postgresql-prisma-foundation.md). Ne jamais cibler la base de développement pour les contourner.

L'[état courant](docs/development/current-milestone.md) indique les prochaines actions et les qualifications encore ouvertes.
