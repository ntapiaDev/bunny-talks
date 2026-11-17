# Architecture mobile — jalon 4.5B0

## Audit et frontières

L'entrée `index.ts` installe d'abord `expo-crypto.getRandomValues` comme source globale, puis charge Expo et la composition. Cet ordre est nécessaire aux consommateurs cryptographiques. La configuration Expo active SQLCipher et SecureStore ; Metro conserve la résolution ESM de `jsonc-parser`. Aucun projet natif n'a été modifié.

- `src/composition` compose l'écran de diagnostic et crée une seule instance applicative du fournisseur de coffre et de son coordinateur Argon2id. Leur durée de vie est celle du module, indépendante des remontages React. Le contrôleur de diagnostic reste propre à chaque montage.
- `src/features/diagnostics/DiagnosticsScreen.tsx` ne connaît que React, React Native et le type de résultat. Les actions et le constructeur du contrôleur lui sont fournis par la composition.
- `src/features/diagnostics` contient les scénarios expérimentaux et leurs helpers d'état et de témoins. Les scénarios accèdent encore directement aux API publiques OpenE2EE, aux stores Expo SQLCipher et SecureStore, à Expo Crypto et aux vecteurs JSON publics des tests de `crypto-backup`. Ces dépendances sont limitées à la qualification et ne définissent pas des parcours de production. `native-argon2-diagnostics.ts` et son fournisseur d'essai ne sont actuellement pas reliés à l'écran.
- `src/infrastructure/crypto` regroupe les adaptateurs natifs distincts, l'installation de l'aléa et le coordinateur. Le fournisseur de coffre utilise le contrat de `crypto-backup` ; le fournisseur Argon2 de qualification conserve ses propres limites. Ces éléments sont des candidats réutilisables, pas des composants validés pour la production.
- Les packages partagés ne dépendent pas du mobile. Les tests contrôlent cette direction, les imports de l'écran, l'absence de cycles locaux et l'ordre de l'entrée. Ils ne prouvent pas l'absence de toutes les dépendances indirectes possibles.

Les noms de bases, clés SecureStore, formats et étapes de diagnostic sont conservés. Aucun mécanisme de suppression ou de réinitialisation n'est ajouté. Les résultats historiques des qualifications demeurent dans leurs rapports respectifs ; ce déplacement ne valide pas la persistance après redémarrage Android, ni iOS ou la production.

## Extensions

Les futures fonctionnalités pourront être ajoutées sous `features` lorsque leurs besoins seront définis, avec des ports explicites là où une frontière technique ou de sécurité le justifie. Aucun client HTTP, domaine vide ou conteneur de dépendances n'est anticipé. Avant de réutiliser les adaptateurs ou scénarios pour des données réelles, leurs contrats, leur persistance et leur sécurité devront être conçus et qualifiés ; SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.
