# Qualification Android/Hermes du coffre E2EE — 14 novembre 2026

**Statut : qualification partielle, non validée.** Le diagnostic rapide exécute les API réelles de `crypto-backup` sur un émulateur Android 17/Hermes. La première dérivation Argon2id du profil candidat a été interrompue avant son résultat : les deux parcours complets, la persistance après redémarrage et les opérations impliquant le mot de passe restent non qualifiés. Aucun parcours de récupération de compte n'est démontré. SEC-CRYPTO-002 et SEC-CRYPTO-003 restent ouverts.

## Environnement observé

Branche `feature/crypto`, Node 24.22.2, pnpm 10.34.9 ; émulateur Android 17 `emulator-5554` et Development Build existant. ADB Windows a effectivement listé l'émulateur. Metro existant sur 8081 répondait ; un Metro distinct a été démarré sur 8082 pour charger la configuration modifiée, sans interrompre celui de 8081. Le projet Android généré n'a pas été modifié manuellement et aucun plugin natif ni module natif n'a été ajouté ; le nouveau package est une dépendance de workspace JavaScript. Aucun nouvel APK n'a été construit.

L'entrée mobile installe d'abord `expo-crypto.getRandomValues` sur `globalThis.crypto`. Le fournisseur explicite du diagnostic appelle directement cette même fonction, sans `Math.random`. Les contrôles vérifient son installation et la taille des secrets obtenus ; ils ne démontrent pas l'entropie. Le code Expo Android et le chemin de repli de `getRandomBytes`, non utilisé ici, avaient été examinés dans la qualification OpenE2EE. L'absence réelle du module natif et son échec n'ont pas été injectés sur Android. Les tests Node du fournisseur global simulent une erreur, sans constituer une panne native.

## Incompatibilité Metro et correction ciblée

Le premier export Metro Android a réussi, mais le chargement natif a échoué avec `Requiring unknown module "./impl/format"`. Le manifeste installé de `jsonc-parser` 3.3.1 pointe `main` vers son entrée UMD, dont les appels `require` sont reçus par un wrapper dynamique que Metro ne résout pas correctement. Le bundle n'a donc pas été exécuté à cette tentative.

`apps/mobile/metro.config.js` demande à Metro l'entrée ESM distribuée par le même package pour la seule résolution `jsonc-parser`. Aucun format de coffre, validateur ni paramètre cryptographique n'a été modifié. Après redémarrage sur le Metro distinct et sélection du bundle correspondant, l'application a démarré sous Hermes et les contrôles rapides ci-dessous ont réussi. Une configuration Metro change le bundle JavaScript et exige le redémarrage de Metro ; ce changement seul ne nécessite pas de reconstruction native. Le chemin ESM précis doit être revérifié à toute mise à jour de la dépendance.

## Résultats Android observés

Sur un passage du diagnostic rapide :

- Génération réelle de la clé maîtresse, de la clé de récupération et de l'identifiant du coffre par Expo Crypto : **5 ms** pour le groupe ; longueurs et distinction des clés contrôlées.
- Dérivation HKDF récupération comparée au vecteur indépendant existant : **5 ms**.
- Ouverture du vecteur indépendant de publication par la clé de récupération, vérification du manifest et comparaison du plaintext exact : **63 ms** pour le groupe. Le groupe inclut également les refus d'une mauvaise clé, d'un compte différent et d'un manifest modifié.

Un second passage, après ajout d’assertions sur les codes précis `AUTHENTICATION_FAILED` et `CONTEXT_MISMATCH`, a réussi avec respectivement 2 ms, 2 ms et 32 ms pour ces trois groupes. Ces durées viennent de `performance.now()` dans l'application. Ce sont des observations ponctuelles sur émulateur, sans contrôle de charge ni statistique ; elles ne représentent pas les téléphones. Le vecteur contient uniquement des valeurs publiques de test. Sa production indépendante par Node/Python/libsodium est documentée dans `account-vault-v1.md`. Le test rapide ne compare pas une création Android aux octets du vecteur.

Lors d'un premier passage complet, la génération native et HKDF avaient aussi réussi en 22 ms et 17 ms respectivement. L'interface affichait ensuite la dérivation Argon2id 64 Mio/3 passes/4 voies en cours pendant plusieurs observations. Le processus Android avait alors accumulé **50 secondes de CPU au total**, y compris le démarrage ; ce nombre n'est pas une durée mesurée isolée d'Argon2id. L'essai a été interrompu par `am force-stop` avant résultat pour éviter d'enchaîner d'autres calculs coûteux. Aucune durée de dérivation, aucun résultat de vecteur Argon2id et aucun verdict de crash ou d'échec d'allocation ne sont disponibles. Ne pas conclure à une incompatibilité cryptographique à partir d'un calcul interrompu.

Une lecture ponctuelle `dumpsys meminfo` pendant l'essai indiquait **368 558 Kio PSS** et **514 696 Kio RSS** pour l'ensemble du processus. Elle ne mesure ni le pic ni la mémoire propre à Argon2id. L'arbre Android restait interrogeable par ADB ; cela ne prouve pas que le thread JavaScript ou l'interface React étaient réactifs. Aucun suivi de latence de frame ni profil mémoire n'a été effectué. Dans Noble installé, la variante asynchrone cède périodiquement à l'ordonnanceur mais reste exécutée en JavaScript ; cela ne démontre pas une exécution en thread séparé.

Le diagnostic sépare maintenant les contrôles rapides du parcours complet. Le parcours complet arrête les étapes coûteuses suivantes si le premier Argon2id terminé dépasse 15 secondes. Ce seuil ne peut pas interrompre la dérivation déjà en cours : un arrêt externe peut rester nécessaire. Aucun abaissement du profil ni repli cryptographique n'a été introduit.

## Persistance et limites

Le scénario complet utilise quatre entrées SecureStore distinctes, préfixées `bunny.vault.diagnostic.v1.` : mot de passe de test généré, clé de récupération de test, publication chiffrée et témoin contenant contexte, marqueur de runtime et empreinte SHA-256 de la publication. Les entrées incomplètes ou vides sont refusées sans réinitialisation ni écrasement. Une restauration compare l'empreinte avant ouverture ; un changement de runtime ne démontre pas seul un arrêt de processus. L'arrêt forcé externe est nécessaire à cette démonstration. La vérification rapide d'un enregistrement existant s'arrête à la structure, sans Argon2id.

Aucune publication n'a été créée ni enregistrée lors de l'essai interrompu ; la persistance, la reprise, la génération conservée et les deux ouvertures après redémarrage n'ont donc pas été exécutées. SecureStore protège les secrets de diagnostic plutôt qu'un fichier ordinaire ; ses garanties et limites natives restent à qualifier. Les écritures des quatre entrées ne sont pas atomiques et l'état partiel est conservé pour diagnostic. Il ne s'agit ni d'un stockage métier ni d'une publication serveur atomique.

La création des enveloppes et d'un coffre complet, l'ouverture par mot de passe, la mauvaise saisie du mot de passe, le réenveloppement, le nouvel accès et la comparaison Argon2id Android/Node restent à exécuter. Les refus de coffre différent, version et profil invalides, et l'absence de dérivation coûteuse sur entrée invalide ne sont pas encore démontrés par cet essai natif. Les tests Node du package restent distincts et ne prouvent pas ces comportements sous Hermes. Le diagnostic existant OpenE2EE n'a pas été rejoué dans ce jalon ; ses stores n'ont pas été réinitialisés.

La lenteur observée appelle une qualification séparée sur appareils représentatifs et une investigation du fournisseur Argon2id, notamment une alternative native maintenue et ses bindings, licences, vecteurs et modes d'échec. Un tel choix exige sa propre revue et potentiellement une reconstruction ; aucune dépendance native n'est décidée ici. Le coffre reste soumis aux limites de rollback, de disponibilité et d'autorisation décrites dans sa spécification.

## Reproduction

Dans WSL, démarrer après toute modification de `metro.config.js` :

```sh
pnpm --filter @bunny-talks/mobile exec expo start --dev-client --port 8082 --offline
ADB_WIN=/mnt/c/Users/Nicolas/AppData/Local/Android/Sdk/platform-tools/adb.exe
"$ADB_WIN" -s emulator-5554 reverse tcp:8082 tcp:8082
"$ADB_WIN" -s emulator-5554 shell am start -a android.intent.action.VIEW -d 'exp+bunny-talks://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8082' fr.bunnytalks.mobile
```

Choisir **Contrôles rapides du coffre**. Le bouton complet lance un Argon2id réel à 64 Mio ; l'essai observé a nécessité un arrêt externe. Ne pas relancer automatiquement des calculs coûteux sans comprendre la limite observée. Si la publication de diagnostic est créée, procéder à un arrêt forcé et relancer explicitement le scénario complet pour sa reprise ; ne pas effacer les entrées SecureStore pour contourner une erreur.
