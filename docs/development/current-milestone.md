# Jalon CRYPTO-011 — Fondations de crypto-backup

**Audit suivant :** [CRYPTO-FIX-001](crypto-fix-001-audit.md) examine les jalons CRYPTO-001 à CRYPTO-011 avant toute suite ; CRYPTO-012 n'est pas commencé.

**Statut :** validation structurelle expérimentale sous Node, pour revue ; coffre et production non validés.

## Résultat

`@bunny-talks/crypto-backup` est un package NodeNext indépendant d'OpenE2EE. Il expose `validateEnvelopeStructureV1`, un résultat portant le statut `structural-only-unauthenticated`, et le contrat asynchrone `CryptographicRandomSource` sans fournisseur. `canonicalize` 5.0.0 et `jsonc-parser` 3.3.1 sont des dépendances directes d'exécution du package pour ce validateur expérimental ; leur compatibilité mobile et leur choix pour production restent à valider. Le type d'aléa ne prouve pas que son implémentation est cryptographiquement sûre ; la future orchestration devra refuser une source absente ou non autorisée et propager les erreurs sans repli faible.

Le validateur prend une copie des octets après limite d'entrée, rejette UTF-8 malformé et BOM, contrôle les événements de parsing strict, champs et doublons décodés, profondeur maximale, tailles, Base64url canonique et format, puis compare le JSON canonique. Il retourne des chaînes immuables, sans modifier l'entrée. Le résultat ne vérifie ni authenticité, ni compte attendu, ni fraîcheur, ni autorisation ; il ne faut pas l'utiliser comme preuve d'un de ces états.

Les tests sous Node réutilisent le vecteur CRYPTO-008 et couvrent notamment les erreurs structurelles, les tailles et une entrée profondément imbriquée. Aucun chiffrement, déchiffrement, import d'identité, stockage ou autorisation n'est implémenté.

La revue finale isole la conversion des `SyntaxError` à l'appel `JSON.parse` ; les exceptions inattendues du visiteur et du canoniseur restent propagées. Les caractères de doublon échappé et de substitut isolé sont vérifiés dans les octets des fixtures. Des tests instrumentés observent l'arrêt au troisième objet pour plusieurs profondeurs ainsi que le rejet d'un tableau ou champ inconnu avant visite de leur contenu. Ces observations ne mesurent pas les allocations internes.

## Limites et décisions ouvertes

- **Pas de déclaration de résistance complète aux attaques par allocation.** L'entrée totale est limitée à 131 072 octets et le visiteur interrompt la profondeur au-delà de deux objets ; `jsonc-parser` scanne et peut allouer les chaînes avant leurs callbacks. Les allocations réelles, les extrêmes de temps et les limites sur Hermes/iOS/Android n'ont pas été mesurés. Les limites restent candidates et doivent être justifiées par la charge réelle.
- `TextDecoder` fatal, `canonicalize` et son besoin `String.prototype.isWellFormed` n'ont pas été validés sur Hermes. Les tests Node ne constituent ni validation mobile ni audit de sécurité.
- La vérification du compte attendu, l'authentification AEAD, la fraîcheur indépendante et l'autorisation individuelle restent des responsabilités distinctes et non implémentées. La gestion des versions futures et l'interface sûre de données authentifiées restent à concevoir.
- Aucun CSPRNG ni adaptateur mobile n'est fourni ou approuvé ; il faut inspecter les chemins de débogage et proscrire tout repli prévisible.
- **SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts et bloquants avant association ou récupération en production.**

Attendre la revue avant d'engager CRYPTO-012.
