# CRYPTO-006 — Spécification candidate du coffre de récupération

**Statut : proposition pour revue, non implémentée et non validée pour la production.** Les noms, limites, contrats et octets ci-dessous constituent un profil candidat cohérent à examiner, pas un format déployé ni un choix définitif de fournisseur. Les primitives standard ne rendent pas automatiquement sûre leur composition ; une revue cryptographique indépendante et des tests d'interopérabilité sont préalables à son adoption. CRYPTO-005 a seulement caractérisé des primitives sous Node.

## 1. Frontières et responsabilités

La séparation suivante précise [ADR-001](../architecture/decisions/001-crypto-packages.md) sans créer ni modifier de package :

- **Coffre générique**, candidat pour `crypto/backup` : octets opaques, secret de récupération, enveloppe, dérivation, AEAD et validation structurelle. Il ne connaît ni OpenE2EE, ni l'identité, ni le stockage, ni l'autorisation. Un fournisseur cryptographique et un CSPRNG sont à sélectionner et tester par plateforme ; aucun accès aux modules internes du SDK.
- **Coffre d'identité Bunny Talks**, couche de composition candidate dans `crypto/backup` : construit et valide une charge métier versionnée, demande au moteur la validation des paires durables, vérifie les clés d'archive et leurs versions lorsque leur contrat existera. L'adaptation OpenE2EE reste dans `crypto/engine`, les contrats indépendants du SDK dans `crypto/core`. L'emplacement précis et les dépendances restent à valider avant création effective.
- **Orchestrateur de récupération** distinct : authentification du compte, origine fiable du contexte attendu, accès et publication conditionnelle au stockage, contrôle de fraîcheur, autorisation, installation locale et reprise. Déchiffrer le coffre ne valide aucune de ces étapes.

La charge métier doit contenir les deux paires durables validées et les clés ou références cryptographiques d'archive indispensables à sa lecture, avec leurs versions ; leur représentation et les vérifications d'archive restent à définir. Elle exclut sessions, ratchets, préclés, registration ID, clés locales et secrets propres à un appareil. Aucun champ inconnu ne doit être utilisé silencieusement ; sa politique exacte relève de la future version de charge métier. La cohérence des paires ne prouve ni l'origine ni l'autorisation de l'appareil.

## 2. Profil candidat et hypothèses

Le secret est généré localement par un CSPRNG éprouvé : proposition de **32 octets aléatoires uniformes**, donc au moins 128 bits d'entropie effective si la source respecte son contrat. Il ne s'agit pas d'un mot de passe ; le format de présentation humain, son contrôle d'erreur et sa saisie restent à définir. HKDF-SHA-256 extrait et dérive une clé d'enveloppement de 32 octets à partir du secret et d'un sel aléatoire de 16 octets. Une clé de contenu indépendante de 32 octets et deux nonces XChaCha20-Poly1305 indépendants de 24 octets sont générés par CSPRNG pour chaque nouvelle enveloppe. Chaque opération AEAD utilise des données associées et produit un tag de 16 octets.

L'entropie effective dépend du générateur, pas de la longueur seule ; HKDF n'ajoute ni entropie ni coût significatif par tentative hors ligne. Le vol du secret ou la compromission du client permettent le déchiffrement. Une phrase choisie par l'utilisateur exige une autre conception, notamment une KDF résistante aux essais comme Argon2id et des limites de ressources. Argon2id pour un secret aléatoire et AES-256-GCM demeurent des alternatives à évaluer ; aucun fournisseur ni paramètre de production n'est choisi. Voir [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html), [RFC 5116](https://www.rfc-editor.org/rfc/rfc5116.html) et [Internet-Draft XChaCha expiré](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha-03).

### Comparaison des compositions

La comparaison ci-dessous suppose un secret de récupération et le même profil candidat HKDF/XChaCha. Le secret lui-même est distinct des clés AEAD comptées dans le tableau.

| Critère                  | A — Chiffrement direct                                                                                                                                           | B — Clé de contenu indépendante, proposée ici                                                                                                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clés et opérations       | Une clé AEAD dérivée, un nonce et une opération AEAD par création ; une dérivation HKDF.                                                                         | Une clé d'enveloppement dérivée et une clé de contenu aléatoire, deux nonces et deux opérations AEAD par création ; une dérivation HKDF.                                                                                                                                                                   |
| Contexte authentifié     | L'unique AEAD authentifie les métadonnées utiles ; leur définition et l'identité attendue restent indispensables.                                                | Deux AEAD authentifient l'en-tête complet avec des préfixes de domaine différents ; les deux vérifications doivent réussir.                                                                                                                                                                                |
| Rotation du secret       | Déchiffrer puis rechiffrer le contenu avec le nouveau secret, un nouveau sel et un nouveau nonce.                                                                | La proposition actuelle authentifie l'ancien coffre puis rechiffre le contenu avec une nouvelle clé, un nouveau sel et de nouveaux nonces : modifier l'en-tête authentifié invalide aussi le tag du contenu. Elle ne permet donc pas une rotation du seul emballage.                                       |
| Copies antérieures       | Une ancienne copie reste ouvrable avec son ancien secret.                                                                                                        | Même limite ; changer ou réenvelopper la clé ne supprime pas les copies ni les clés déjà obtenues.                                                                                                                                                                                                         |
| Format, tests et erreurs | Moins de champs, de tests de composition et d'états intermédiaires ; surface d'erreur plus réduite. Il faut toujours contrôler nonces, AAD, contexte et reprise. | Plus de champs, tags, domaines, étapes et données sensibles temporaires ; risques supplémentaires de confusion de clés, nonces ou AAD, d'exposition partielle et d'incohérence entre couches. Tests et revue plus coûteux.                                                                                 |
| Évolution                | Facile pour un seul secret et un seul contenu ; plusieurs mécanismes d'accès ou destinataires peuvent nécessiter une nouvelle composition et une migration.      | La séparation des clés peut faciliter de futurs modes d'enveloppement ou destinataires, mais ne les garantit pas. Éviter de rechiffrer le contenu exigerait une conception différente des métadonnées authentifiées, à spécifier et auditer ; ce n'est pas une propriété de V1.                            |
| Formats existants        | Certains formats ou modes permettent une clé directe ; vérifier concrètement algorithmes, contexte, versionnement et disponibilité Node/mobile.                  | [JWE](https://www.rfc-editor.org/rfc/rfc7516.html) décrit des modes directs et d'enveloppement d'une clé de contenu ; [age](https://github.com/C2SP/C2SP/blob/main/age.md) utilise aussi une clé de fichier. Aucun de ces faits ne démontre leur compatibilité avec notre profil exact, notre AAD ou Expo. |

**Recommandation pour la revue :** conserver B comme candidat déjà documenté, pour examiner une séparation explicite entre clé de contenu et secret de récupération. Elle ajoute de la complexité sans avantage de rotation immédiat dans ce format ; A mérite donc une comparaison réelle avant sélection, notamment si aucun besoin concret de plusieurs enveloppes n'apparaît. Aucune supériorité cryptographique générale ni compatibilité avec un format existant n'est établie. L'adoption de l'une ou l'autre nécessite une justification des besoins, des tests indépendants et une revue de sécurité.

## 3. Proposition d'enveloppe V1

Le tableau décrit les champs **obligatoires**, sans valeur par défaut ni extension implicite. Les identifiants et nombres ci-dessous sont proposés uniquement pour cette revue. Tout champ inconnu, champ dupliqué, type incorrect ou valeur non reconnue entraîne un refus avant dérivation ; une future extension requiert un contrat de version explicitement pris en charge.

| Emplacement | Champ          | Proposition V1                                                                                                                |
| ----------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Racine      | `header`       | Objet contenant exactement les champs ci-dessous.                                                                             |
| Racine      | `wrappedKey`   | Base64url canonique sans padding de 48 octets : clé de contenu chiffrée de 32 octets suivie du tag de 16 octets.              |
| Racine      | `ciphertext`   | Base64url canonique sans padding de 16 à 65 552 octets : charge chiffrée suivie du tag de 16 octets.                          |
| `header`    | `format`       | Chaîne exacte `bunny-recovery-vault`.                                                                                         |
| `header`    | `version`      | Entier JSON `1`.                                                                                                              |
| `header`    | `profile`      | Chaîne exacte `hkdf-sha256-xchacha20poly1305-v1`.                                                                             |
| `header`    | `account`      | Base64url canonique de 16 octets, identifiant opaque stable du compte ; sa source et son attribution sûres restent à définir. |
| `header`    | `purpose`      | Chaîne exacte `identity-recovery`.                                                                                            |
| `header`    | `generation`   | Entier JSON de 1 à 9 007 199 254 740 991 inclus ; incrémenté à chaque publication, sans débordement.                          |
| `header`    | `salt`         | Base64url canonique de 16 octets aléatoires.                                                                                  |
| `header`    | `wrapNonce`    | Base64url canonique de 24 octets aléatoires.                                                                                  |
| `header`    | `contentNonce` | Base64url canonique de 24 octets aléatoires, générés indépendamment.                                                          |

La représentation proposée est UTF-8 strict de l'objet JSON complet selon [JCS, RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html), sans BOM ni octets supplémentaires. JCS est une RFC informative, pas une certification du format. Pour les octets, utiliser Base64url selon [RFC 4648 §5](https://www.rfc-editor.org/rfc/rfc4648.html#section-5), sans `=`, espaces ni caractères hors alphabet ; décoder puis réencoder et exiger l'égalité pour rejeter les bits de remplissage non canoniques. Les nombres sont des entiers sûrs, sans notation alternative sur le fil. L'ordre des propriétés est celui de JCS, non celui du tableau. Une sérialisation déterministe signifie mêmes octets pour le même objet, pas même coffre pour deux créations aléatoires.

### Traitement exact proposé

1. Produire `H = UTF8(JCS(header))`. Dériver `KEK = HKDF-SHA-256(secret, salt, info, 32)`, avec `info` égal aux octets ASCII exacts `bunny-talks/recovery-vault/v1/wrap-key`. Cette étiquette de domaine versionnée n'est pas fournie par l'enveloppe.
2. Produire `wrappedKey` par XChaCha20-Poly1305 avec `KEK`, `wrapNonce`, la clé de contenu comme plaintext et `AAD = UTF8("bunny-talks/recovery-vault/v1/wrap\n") || H`.
3. Produire `ciphertext` avec la clé de contenu, `contentNonce`, les octets de charge et `AAD = UTF8("bunny-talks/recovery-vault/v1/content\n") || H`. Les préfixes fixes distincts et l'en-tête complet lient l'usage, le compte, la génération, le profil et les paramètres aux deux opérations.
4. Encoder les résultats dans l'objet racine puis sérialiser selon JCS. Les tags sont les 16 derniers octets de chaque résultat, selon l'API combinée retenue ; aucune valeur d'exemple ne sert de nonce de production.

La clé d'enveloppement et la clé de contenu sont distinctes par construction ; les étiquettes de contexte sont fixes et versionnées. Les paires clé/nonce ne doivent jamais être réutilisées. Chaque création ou rotation génère un nouveau sel, deux nouveaux nonces et une nouvelle clé de contenu ; la collision aléatoire n'est pas impossible. Il faut définir et vérifier un plafond d'usage et le comportement d'échec du CSPRNG. Le déchiffrement des deux couches doit réussir avant de retourner la charge ; aucune donnée partielle ne doit être exposée. Cette composition candidate, sa résistance aux clés adversariales et sa possible substitution par un format standard existant exigent une revue indépendante.

### Validation avant dérivation

- Limiter l'entrée brute à **131 072 octets** et la charge déchiffrée à **65 536 octets** ; ces plafonds conservateurs sont candidats et doivent être justifiés par les besoins réels avant adoption. Vérifier les longueurs encodées avant toute allocation importante ou décodage.
- Décoder l'UTF-8 strictement ; analyser avec détection des noms dupliqués à tous les niveaux avant qu'ils ne soient perdus, limiter la profondeur à deux objets, refuser tableaux et types inattendus. Comparer ensuite les octets d'entrée avec la sérialisation JCS ; refuser toute représentation non canonique.
- Exiger exactement les champs, les constantes, les plages et les longueurs décrites ; vérifier l'encodage canonique des octets, la longueur minimale du tag et les tailles maximales décodées. Ne pas dériver si un contrôle échoue. Ne jamais tenter silencieusement un autre profil ou une version antérieure.
- Comparer `account` et `purpose` à des valeurs attendues fournies **indépendamment** de l'enveloppe par l'orchestrateur ; un compte fourni seulement par le même serveur non fiable ne prouve pas sa provenance. Le contenu de l'en-tête reste non authentifié jusqu'à la réussite des deux AEAD.
- Après authentification, vérifier la charge métier et l'identité durable avant toute écriture ou activation. La validation structurelle seule ne prouve ni possession du secret, ni intégrité, ni fraîcheur, ni autorisation.

Le parseur doit détecter les doublons sur les noms **décodés** : par exemple, `"account"` et `"acc\u006funt"` désignent la même clé. `JSON.parse` seul ne convient pas : il perd l'information sur les doublons. Utiliser un parseur adapté ou une analyse lexicale éprouvée ; borner les octets avant décodage, la profondeur, le nombre de champs et les longueurs de chaînes avant allocation, y compris pour les documents rejetés. Refuser UTF-8 malformé, BOM, caractères Unicode invalides ou substituts UTF-16 isolés, y compris sous forme d'échappements JSON. JCS conserve les chaînes Unicode telles qu'elles ont été décodées : aucune normalisation NFC ou NFD implicite. Pour ce profil, tous les noms et toutes les valeurs textuelles admises sont ASCII ou Base64url ; tout autre caractère est rejeté par le schéma. La comparaison exacte au JCS final rejette aussi espaces, ordre ou échappements non canoniques, sans corriger silencieusement l'entrée.

Les deux plafonds restent des valeurs **candidates**, pas des capacités mesurées : inventorier les tailles réelles des deux paires d'identité, des secrets et versions d'archive, des métadonnées et de leur sérialisation, puis calculer le surcoût des tags, du Base64url, de l'en-tête et de JCS. Vérifier les scénarios d'évolution, les pires cas légitimes et la mémoire maximale sur les appareils cibles, en gardant une marge documentée et des tests juste sous, à et au-dessus des limites. Si le contenu légitime dépasse une limite, réviser le profil et sa migration avant adoption ; ne pas tronquer silencieusement. La taille de la charge d'identité elle-même et sa structure ne sont pas encore définies.

## 4. Contrats TypeScript illustratifs

Ces signatures décrivent des responsabilités, ne modifient aucune API existante et ne choisissent ni représentation humaine du secret ni fournisseur. Les types opaques seraient construits par des fonctions de validation, jamais par un cast à partir d'entrées non fiables.

```ts
type RecoverySecret = Uint8Array & { readonly __recoverySecret: unique symbol };
type ValidatedEnvelope = { readonly __validatedEnvelope: unique symbol };
type VaultContext = { readonly account: Uint8Array; readonly purpose: 'identity-recovery' };
type VaultErrorCode =
  | 'MALFORMED_ENVELOPE'
  | 'UNSUPPORTED_FORMAT'
  | 'CONTEXT_MISMATCH'
  | 'AUTHENTICATION_FAILED'
  | 'INVALID_SECRET'
  | 'RESOURCE_LIMIT'
  | 'CRYPTO_UNAVAILABLE'
  | 'INTERNAL_ERROR';
type VaultResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: VaultErrorCode };

interface RecoveryVault {
  generateSecret(): Promise<VaultResult<RecoverySecret>>;
  validateEnvelope(encoded: Uint8Array, expected: VaultContext): VaultResult<ValidatedEnvelope>;
  create(
    secret: RecoverySecret,
    plaintext: Uint8Array,
    context: VaultContext,
    generation: number,
  ): Promise<VaultResult<Uint8Array>>;
  open(secret: RecoverySecret, envelope: ValidatedEnvelope): Promise<VaultResult<Uint8Array>>;
  rewrap(
    oldSecret: RecoverySecret,
    newSecret: RecoverySecret,
    envelope: ValidatedEnvelope,
    nextGeneration: number,
  ): Promise<VaultResult<Uint8Array>>;
}
```

`ValidatedEnvelope` est une copie immuable encapsulée, liée aux octets et au contexte effectivement contrôlés : aucune référence mutable de l'appelant ne doit permettre de modifier les données entre validation et ouverture. `open` réauthentifie toujours ; un objet validé structurellement ne devient jamais une preuve cryptographique. `rewrap` authentifie l'ancien coffre, exige `nextGeneration = generation + 1` sans débordement, puis recrée l'enveloppe avec nouvelle clé de contenu, nouveau sel et nouveaux nonces. Il retourne des octets candidats ; il ne publie ni n'efface l'ancienne version. Un changement du contenu et une rotation simultanés nécessitent un contrat d'orchestration distinct.

Le contrat d'erreur distingue les catégories suivantes, sans imposer leur exposition détaillée à une interface ou à un tiers :

- `INVALID_SECRET` : représentation ou longueur du secret invalide avant dérivation, y compris erreur de décodage humain une fois son format défini. Une longueur valide ne prouve ni entropie ni exactitude du secret.
- `AUTHENTICATION_FAILED` : échec de vérification AEAD après entrée structurellement acceptable ; un secret incorrect et un ciphertext, tag ou contexte authentifié altéré ne sont pas distinguables de manière fiable et partagent ce résultat.
- `MALFORMED_ENVELOPE` : structure, encodage, champ ou valeur invalide ; `RESOURCE_LIMIT` signale une limite de ressources dépassée. `UNSUPPORTED_FORMAT` désigne un identifiant, une version ou un profil reconnu syntaxiquement mais non pris en charge. Les priorités exactes lorsque plusieurs erreurs coexistent restent à définir sans traitement coûteux préalable.
- `CONTEXT_MISMATCH` : comparaison préalable du compte ou de l'usage attendu avec l'en-tête encore non authentifié ; ce résultat ne prouve pas une altération ni l'identité de l'émetteur.
- `CRYPTO_UNAVAILABLE` : fournisseur ou CSPRNG indisponible ; `INTERNAL_ERROR` : défaut inattendu. Ne jamais les convertir en erreur de secret ou d'authentification. La classification précise des erreurs du fournisseur doit être vérifiée pour chaque plateforme.

Les messages publics et logs ne contiennent jamais clé, secret, plaintext, enveloppe complète ou erreur brute du fournisseur susceptible de les contenir. Le traitement des détails diagnostiques doit éviter un oracle exposé aux attaquants. La propriété et la durée de vie des buffers restent à préciser : effacer les copies sensibles mutables en `finally` sans modifier les buffers de l'appelant ; JavaScript, son ramasse-miettes et les copies du moteur ne permettent pas de garantir l'effacement ni le temps constant.

## 5. Publication, rotation et reprise

Le coffre générique ne réalise aucune écriture. L'orchestrateur doit conserver l'ancienne version récupérable, préparer et valider la nouvelle, puis utiliser une publication durable et conditionnelle sur la version attendue, coordonnant tous les écrivains. Un conflit doit être signalé et résolu après relecture, sans écrasement ; un mutex JavaScript seul ne protège pas plusieurs processus. Les garanties réelles de transaction, durabilité, coordination du secret et reprise dépendent des backends et doivent être spécifiées et testées. Après résultat de publication incertain, conserver les deux états, isoler l'opération et réconcilier avant toute suppression ou nouvelle écriture.

Trois notions doivent rester distinctes :

- **Génération cryptographique du coffre** : `generation` dans l'en-tête authentifié, incrémentée par le client à chaque publication selon le contrat candidat. Elle exprime l'ordre déclaré de versions légitimes après vérification AEAD, pas leur fraîcheur absolue.
- **Révision transactionnelle de stockage** : jeton opaque ou numéro de version externe au coffre, fourni par le backend pour une écriture conditionnelle sur l'état lu. Il sert à détecter les conflits entre écrivains si le backend respecte son contrat ; il n'est pas nécessairement égal à `generation`, ni authentifié par le coffre, ni une ancre de confiance.
- **Référence indépendante de fraîcheur** : état fiable conservé ou vérifiable hors du contrôle exclusif du serveur présentant le coffre, permettant de comparer une génération et, si nécessaire, l'identité de la version. Son modèle de confiance, son authenticité, sa disponibilité et son traitement des divergences restent à concevoir.

Aucune de ces valeurs ne protège à elle seule complètement contre un serveur activement malveillant : une référence indépendante ne suffit que dans les limites de son propre modèle de confiance et de disponibilité.

Lors d'un changement de secret, vérifier le nouveau secret et l'enveloppe produite avant publication ; la conservation sûre du nouveau secret et le traitement d'une interruption avant ou après publication restent à concevoir. Une ancienne copie du coffre reste déchiffrable avec l'ancien secret : réenvelopper ne révoque ni copies ni secrets déjà compromis. En cas de compromission, une éventuelle rotation des secrets durables et des clés d'archive, avec ses conséquences sur les autres appareils et l'historique, est une exigence distincte à concevoir.

Une génération authentifiée peut détecter un retour arrière **seulement si elle est comparée à une référence indépendante et fiable**. Un contrôle de concurrence ou un compteur stocké sur le même serveur ne suffit pas contre ce serveur malveillant, qui peut aussi présenter des histoires divergentes. Avec un appareil de confiance, une référence locale ou comparée peut aider sous réserve de sa protection et d'une procédure de résolution ; après perte de tous les appareils, sans ancre indépendante, un ancien coffre valide peut être indiscernable du dernier. Ne jamais effacer l'état existant ni activer l'appareil en cas d'échec, d'état partiel ou de fraîcheur indéterminée ; la politique de récupération et l'expérience utilisateur restent ouvertes.

L'import local de l'identité reste soumis à **SEC-CRYPTO-002** ; l'authentification et l'autorisation individuelles, les rejeux et la reprise restent soumis à **SEC-CRYPTO-003**. Les deux sont ouverts et bloquants avant production. La possession du coffre ou de l'identité ne suffit pas à autoriser un appareil ; la limite de cinq appareils et la révocation relèvent de l'autorisation indépendante.

L'identifiant de compte attendu doit provenir d'un contexte authentifié fiable et indépendant de l'enveloppe ; le mécanisme et la confiance accordée à ce contexte restent à établir. Récupérer les secrets, autoriser individuellement l'appareil, l'activer, révoquer un appareil et publier un coffre sont des opérations distinctes dont l'ordre et les preuves restent à définir. En particulier, changer le mot de passe invalide les sessions d'authentification de tous les autres appareils et conserve celle de l'appareil demandeur ; le serveur refuse les sessions révoquées dès la révocation effective. Les connexions ordinaires simultanées restent autorisées. Cette révocation ne supprime pas les données locales et ne remplace pas la révocation cryptographique des échanges futurs, selon le [modèle de menace](threat-model.md).

## 6. Plan de validation avant implémentation et production

1. Soumettre la composition, l'éventuel format standard de remplacement, les limites et les contrats à revue de sécurité ; obtenir un accord explicite avant toute implémentation. Établir les garanties de la source attendue du compte, de l'ancre de fraîcheur et de l'usage des clés d'archive.
2. Définir des vecteurs déterministes de la composition complète avec valeurs publiques fixées pour secret, sel, nonces, charge et en-tête : octets JCS, `info`, AAD, clés dérivées, deux ciphertexts et tags. Vérifier par une implémentation indépendante, par exemple libsodium via ses API publiques ; ne pas injecter de hasard de test dans l'API de production.
3. Tester JSON invalide ou non UTF-8, doublons, ordre et échappements non canoniques, Base64url non canonique, champs absents ou inconnus, types et nombres incorrects, versions et profils non reconnus, dépassements, tailles exactes autour de chaque limite et absence de dérivation pour les rejets structurels.
4. Tester secret erroné, substitution de compte ou d'usage, modification de chaque champ authentifié, sel, nonces, charge, tags, clés et contextes ; confirmer qu'aucun plaintext partiel ni secret n'apparaît dans les erreurs ou les logs.
5. Tester séparation des usages, génération par CSPRNG et erreurs de fournisseur, rotation, nouveau et ancien secret, copies anciennes toujours déchiffrables, dépassement de génération et échec à chaque étape sans perte de données.
6. Tester concurrence entre processus et backends réels, conflits et résultats incertains, retour arrière authentifié, absence et présence d'ancre indépendante, panne de chaque écriture et reprise des états partiels. Tester l'import local et l'autorisation selon SEC-CRYPTO-002/003.
7. Exécuter vecteurs et échanges croisés Node/iOS/Android sur Expo Development Builds avec Hermes ; mesurer CSPRNG, fournisseur, temps, mémoire, interruptions et stockage sécurisé. Un succès Node ne démontre ni compatibilité mobile ni audit cryptographique.
8. Tester les doublons de noms équivalents après décodage, les séquences Unicode invalides et non normalisées, la classification des erreurs et les échecs du fournisseur ; vérifier que secret incorrect et altération AEAD produisent la même catégorie sans fuite d'information.
9. Tester séparément les divergences entre génération, révision de stockage et référence de fraîcheur, y compris versions concurrentes de même génération, serveur malveillant, indisponibilité de l'ancre et récupération sans appareil. Tester la politique de sessions après changement de mot de passe sur tous les canaux concernés.

## 7. Décisions ouvertes avant toute implémentation

Choisir et examiner la composition ou un format standard existant ; bibliothèque et maintenance ; représentation humaine et source de compte fiable ; hiérarchie et charge d'archive ; bornes et politique de migration ; gestion du CSPRNG et de la mémoire ; disponibilité des implémentations mobiles ; stratégie de publication, ancre de fraîcheur et reprise ; critères d'autorisation et d'activation. Aucun de ces choix n'est validé par le présent document.
