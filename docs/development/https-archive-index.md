# Index de conservation et restauration

## Documents crypto retirés de l'arbre actif

La revue indépendante a confirmé que les quatre fichiers ci-dessous correspondent exactement aux objets de la révision restaurée `ba2c8d44f35e2eb46138e176e421345878f0990c`. Après transfert des exigences et résultats encore utiles vers [l'architecture de récupération active](../security/recovery-vault-architecture.md) et les rapports ciblés, aucun consommateur documentaire ou technique actif ne justifie leur copie dans l'arbre courant. Pour les retrouver, restaurer la révision indiquée dans une copie isolée, extraire le chemin, puis vérifier le SHA-256 avant usage. Les empreintes consignées ici ont été calculées sur les fichiers retirés locaux avant suppression.

| Chemin historique                                         | SHA-256                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `docs/security/recovery-vault-specification.md`           | `5b2a22d4ef842c09c7704328a341ee002b48c57654ce1e5e6fa148b6f0f354bd` |
| `docs/security/recovery-vault-technical-prerequisites.md` | `e369bba802bcac11623856da5d6f0caef3e9f4db8b0557e74505a8403757903a` |
| `docs/security/recovery-vault-component-evaluation.md`    | `6edf97267744cda465e817a1ffdc311bd1cc3c100fdc38ecf51a78a351d73c43` |
| `docs/security/recovery-vault-interop-evaluation.md`      | `f30ca6d1f029874d625982c373cfb0edcac11a3201ab60f8e26d751fdf993a99` |

`recovery-vault-direct-v1.md` reste conservé avec le format et les tests expérimentaux ; `e2ee-transition-audit.md` reste conservé jusqu'à la reprise des décisions OpenE2EE. Les spécifications normatives actives, les décisions non résolues et le modèle de menaces restent en place.

## État et emplacement

Le lot 0 est accepté. Le développeur confirme les six ZIP, leurs contrôles SHA-256 et une sauvegarde Git autonome restaurée sur 32 révisions sur 32 avec intégrité des objets vérifiée. La sauvegarde indépendante hors WSL est confirmée par le développeur. Les vérifications ci-dessous ont été rejouées en lecture seule dans la copie visible depuis WSL; une copie WSL seule ne constitue pas une sauvegarde indépendante.

Emplacement local : `~/.local/share/bunny-talks/archives/https/`. Bundle : `bunny-talks-https-history.bundle`, SHA-256 `929890081bb68c0406da42cebbad58e5fce86d25ccf20702660866fbcf91b563`, 1 893 633 octets. L’inventaire `git-revisions.txt` contient 32 SHA complets : 30 révisions historiques et les clôtures documentaires `ba2c8d44f35e2eb46138e176e421345878f0990c` et `72ee385bb3a51c6bcf6eb34090b664f9e8d5c72a`. La restauration indépendante rapportée par le développeur n’a pas été répétée. Vingt-cinq des 30 révisions historiques ne sont pas des ancêtres de la révision terminale du laboratoire `610ac5362d60c41c8360a87e411ab786c319885e`.

Les ZIP et le bundle visibles localement sont des copies WSL. Ne pas les traiter comme preuve de l’emplacement externe confirmé. Ne pas supprimer ni déplacer la copie indépendante.

## ZIP, empreintes et restauration

| Fichier           | Origine, SHA-256 et contenu contrôlé                                                                                                                                                                                                                                                                       | Restauration                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `14717914245.zip` | Run `44932862906`, révision `ab9a4884e4ce8376d8bcacf6796df80f2df141e6`; `eb1233fd42383b8d7eebc627055ae26da11e49f94e5e8de6fd0b96afecfdd8fa`. ZIP sain; `build.json`, `report.json`, `summary.md`.                                                                                                           | Extraire le ZIP original; restaurer la recette depuis le bundle à la révision indiquée.                                                                                                                                |
| `14723035221.zip` | Run `44942974411`, révision `8b965b0e209e3145bcff0f68fda9586a9c33c144`; `57908367212fb83b17b830e1aa69c0e4282e7afbb4fd368294943216f625d841`. ZIP sain; contient `xcframeworks.tar`, quatre bibliothèques statiques pour appareil/simulateur arm64, manifestes et licences conformes au contrôle historique. | À la révision protégée, utiliser `python3 apps/mobile/modules/application-https/ios/verify_xcframeworks.py archive <zip>`; restaurer source et recette depuis le bundle. Le vérificateur historique a réussi au lot 0. |
| `14722656618.zip` | Révision de fabrication `8b965b0e209e3145bcff0f68fda9586a9c33c144`; `42d052730090bf40b2332dc2540e4f995cdc30a62d48dbb21ac0b234e2452216`. ZIP sain; `report.json`, `manifest.json`.                                                                                                                          | Restaurer rapport et manifeste depuis le ZIP, recette depuis la révision protégée.                                                                                                                                     |
| `15129922529.zip` | Candidate URLSession, run `45841518053`; `990792cc56efa667ed5cfac680600d729263199670eaccd5b6a88bfc8eaee483`. ZIP sain; rapport identique octet pour octet à `evidence/ios-https-urlsession-45841518053/report.json`, SHA du rapport `221f66e50146a2f9832cf3cd6e25f3ae85e427b878ef2c039d74f2d4d51bcadd`.    | Extraire le rapport du ZIP ou lire la copie assainie dans le dépôt; sources à restaurer depuis la révision `b7dca8ed038436a950ac70e040781ca30aa28bc2`.                                                                 |
| `15132180090.zip` | Release standard, run `45841579254`; `88086821ca5712c16905d143e321943e612dfa7db25c74352413f145b53336e7`. ZIP sain; rapport identique à `evidence/ios-standard-runtime-45841579254/report.json`, SHA du rapport `560133c2d3469cb646e7b87f4cd28c81ee2daf2cfca9a44467b47b9e0475a662`.                         | Extraire le rapport ou lire sa copie assainie; sources depuis la révision `b7dca8ed038436a950ac70e040781ca30aa28bc2`.                                                                                                  |
| `15132880416.zip` | Laboratoire, run `45845228016`; `b42e127bbf211ff97e4620e85cf337b8dbe55ad053a711b207d792539844b19d`. ZIP sain; rapport identique à `evidence/ios-standard-https-lab-45845228016/report.json`, SHA du rapport `b23f93e05c42053d55e3f79f8da38a62254b382ce2083a3e4e52d0ed461a45f5`.                            | Extraire le rapport ou lire sa copie assainie; sources depuis la révision `610ac5362d60c41c8360a87e411ab786c319885e`.                                                                                                  |

Vérification de clôture du 26 novembre 2026 : les six SHA-256 du manifeste local correspondent et les six archives passent `unzip -t`. Les trois ZIP Apple originaux correspondent toujours octet pour octet aux rapports assainis conservés, contrôle établi lors de la revue indépendante. Le contenu du ZIP XCFramework est `xcframeworks.tar`; son vérificateur historique a réussi au lot 0 à la révision protégée. La restauration Git indépendante 32/32 et le contrôle d’intégrité des objets ont été effectués par le développeur et ne sont pas rejoués ici. Aucun nouveau duplicata n’a été créé. Les preuves historiques restent hors des dépôts publics lorsqu’elles contiennent des traces brutes, secrets, clés privées, journaux sensibles ou captures mémoire.

## Révisions couvertes

Les SHA ci-dessous sont les 30 historiques de `git-revisions.txt`; ils permettent de retrouver les sources, recettes, tests et configurations au même arbre. Les deux SHA documentaires sont ceux indiqués dans l’état ci-dessus.

- Qualification et terminales : `f468f303b3e0ce8ecb5fdb9172343aef4356d63f`, `9a181a3c74e869a3f85022dc5c4efa5ed80a6f6b`, `b7dca8ed038436a950ac70e040781ca30aa28bc2`, `610ac5362d60c41c8360a87e411ab786c319885e`.
- Prototype Android : `60a129196742e06ec87ad92ee9893d75a63d0946`, `b87b164810edb5471b82f6cce6fb4af7179408a4`.
- Témoin et XCFrameworks : `ab9a4884e4ce8376d8bcacf6796df80f2df141e6`, `8b965b0e209e3145bcff0f68fda9586a9c33c144`, `af989d0150c0d1850ea7beb428016d3459830983`, `4f0a643ca2e7ff15ca81e865289c0e9c62341ed6`.
- Builds EAS et étapes comparatives : `9d1ef16843a174196aa77cad9cf78c638cf43265`, `83f5ed794b2e57beab7d88edeff3369dd25831bf`, `18699b59202d561cc557bf6dd99c081fcc58171a`, `7d6b6f1bd91877832d45baaa6e04dc4e8b2d8eaa`.
- Standards et campagnes : `1bac131e0dcdbb15092d94ed9857ec24d75f714c`, `f3175e24640a712761c5c3697d896dc403a494d8`, `7613e6aa6e51a6c32b1fcd65bc0187ffc899f2f9`, `3eb50758a35ba6d50754a3e37d939351fdc2c1a2`, `82d3f00926d817c70e58752dba9057555fbcf3bf`.
- Tentatives explicatives : `983a9a721d0bfd0bbcd53ab711d9ad5a5ad605ae`, `2ca6717344349d84f5e572e988d65f05c9c5e77c`, `f448078ea858eed0b78f4ac41ad2ccbb41dea117`, `3e295d01f32120bb2223bda75f8bcce3b2b3fa68`, `b6d4e9579acb5896a96c1fb216c08b9d1ee6399f`, `350f227d34e3c28a3c824db9c4d706afbf631acf`, `c14b9814352ed3ab9b7b64367419fb595ffcf246`, `c6711fa0eb8b8f7d968b9dbacdac3816001eb41b`, `51ccb4a6004e261613d91d767ab6338b6e1decba`, `561851e4a06f4885e818b149d199db042be6c3d1`, `fe740dc75b588d582769720392059cdc4f10aa27`.

La sauvegarde Git autonome suffit comme référence compacte; aucune branche ou étiquette de sauvegarde supplémentaire n’est demandée. Le développeur seul décide d’une restauration effective avec Git. Le nettoyage n’a exécuté aucune opération Git.

## Éléments indisponibles

Les archives d’actions et de builds temporaires ne sont pas nécessaires à la restauration des sources protégées. Les traces brutes, captures mémoire Perfetto et journaux privés ne sont pas dans cet index et ne doivent pas être publiés. Les quatre rapports actifs, les six ZIP et le bundle sont les preuves durables référencées ici.

## Rapports retirés de l’arbre actif

La revue indépendante a confirmé l’identité octet pour octet des 41 fichiers avec la révision `ba2c8d44f35e2eb46138e176e421345878f0990c`, couverte par le bundle restauré 32/32. La consolidation conserve les quatre rapports de la [référence HTTPS](native-https-foundation.md). Les 37 fichiers suivants (496 308 octets) n’ont pas de consommateur actif identifié.

Pour lire un rapport retiré, le développeur restaure le bundle dans un dépôt temporaire distinct, sélectionne la révision complète ci-dessus puis extrait le chemin historique. Comparer le SHA-256 avant usage. Les chemins ci-dessous sont relatifs à `docs/development/evidence/`. Le rapport Android maintenu `android-https-standard-step-b/report.json` a pour SHA-256 `0324d9d200a2df1b1829dfe7be328889675afa2499f74655520bb036fc757b76`.

| Chemin historique                                 | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `ios-hosted-feasibility-45480059263/report.json`  | `e5c81fb75e3ea71367bc55450aaea019c35baf5dcd5150f67a5fa7d52d30a99c` |
| `ios-https-candidate-45697564911/report.json`     | `179c199d1ab467aaa785f01c9e41986d6cae8afd26413b93b80c8e9053ce2b7d` |
| `ios-https-candidate-45703034430/report.json`     | `0cfe26a82b4af9016926ec1d350502eab5377f53a733c91331a277a805261d4d` |
| `ios-https-candidate-45703951581/report.json`     | `b3c66c3fbb9f0cffaeee335196e8903d822d1a2fdb1cf45a0300da79b7eea3e9` |
| `ios-https-candidate-45724079914/report.json`     | `568adb583bcda1ac53318e526a9ab88e5b98b50b39083e19ed83f5465bf97935` |
| `ios-https-candidate-45729270920/report.json`     | `7d8c6a6365d93595052ea2973c3f2b058386eacfade1188294bf55af7c72faa7` |
| `ios-https-candidate-45731826851/report.json`     | `6967814583879e0cee28126045fb0bdab93a315c569830617c82588b440c107e` |
| `ios-https-candidate-45732450043/report.json`     | `85ea82b5bea1cb60a6873635d181c67342d6a4b70a6558116f6013c9d0cf8245` |
| `ios-https-candidate-45735483847/report.json`     | `93c837472e46bedd5f3ecdf8ba9f11c77fb2e16f5d31855403c29f9e1500a508` |
| `ios-https-urlsession-45826086010/report.json`    | `65477f6edb311b8cd56809e794f4d28668862f95efc720bba31e1fc71071bd9e` |
| `ios-libcurl-1c5094c4/environment.json`           | `ce21b4c029e1ea2e4d4f3ba69534f9a6d31d728f6487ae985aa1e82e81bcb993` |
| `ios-libcurl-1c5094c4/installed.json`             | `ef7ccb2feddfa16957859f5f7085dcfeb9dbf55c490bf82353f634831baa916a` |
| `ios-libcurl-1c5094c4/link.json`                  | `8f70b6fb54c23352be79642614c5c7041bdc6fb72b370fb578f13211e54f7a2f` |
| `ios-libcurl-1c5094c4/provenance.json`            | `7dcffcf3e479ff6004f64b462befd586ee31c92bcf839146b020b7e8ad2c9817` |
| `ios-libcurl-1c5094c4/runtime.json`               | `ceda532a7a299f9d8b54019cf14a2bdbb65777e6f18b1e7d5b6fe31e32ba15ce` |
| `ios-libcurl-1c5094c4/summary.json`               | `6ea26bfe1dc3f19b1cfc44dc3becf6d87d510def63eadcd8c77524cf097b2ac7` |
| `ios-libcurl-1c5094c4/witness.json`               | `e3983da2ad005b16ddca15941ebbcba5f533c6fcc56f86f99b2521c921f69b1a` |
| `ios-libcurl-78923dbf/environment.json`           | `ae528cbd840a2a119605751390669551b7325f2f80ed92b02bc0da36522943ca` |
| `ios-libcurl-78923dbf/installed.json`             | `fbe6f03b611bc64cdf1dedea95decdccddba3187f819942d4a25b2c19e12e76a` |
| `ios-libcurl-78923dbf/link.json`                  | `e3898f08048ce263181263fa42c082192bc198d602db3c38fa5aca6591e2dbb4` |
| `ios-libcurl-78923dbf/provenance.json`            | `7dcffcf3e479ff6004f64b462befd586ee31c92bcf839146b020b7e8ad2c9817` |
| `ios-libcurl-78923dbf/runtime.json`               | `78822dd2c7a748888f2c94aa8c210b9a138dc971d2484feaffb8d4274c820538` |
| `ios-libcurl-78923dbf/summary.json`               | `87ced1f0c7da6bb8fcef4ceac22d9074859dd42d5d030cc92d7334656601eda2` |
| `ios-libcurl-78923dbf/witness.json`               | `2ef2912e5bd52966a3f0e068d608b9616564ae002f8c569f2715e0554646c555` |
| `ios-libcurl-d2c0010c/environment.json`           | `ee8519a035acf0eccba7896d7821dee104b99fbf255cb456b8d772876fc736ec` |
| `ios-libcurl-d2c0010c/installed.json`             | `100854f86998078d1bf0ec3a6e40c1b852674922724ce8458e30f70a3035f8e8` |
| `ios-libcurl-d2c0010c/link.json`                  | `047c864e9b7d44e370eb4014b817ccefca52084acd4590edf5c51775f1041a27` |
| `ios-libcurl-d2c0010c/provenance.json`            | `7dcffcf3e479ff6004f64b462befd586ee31c92bcf839146b020b7e8ad2c9817` |
| `ios-libcurl-d2c0010c/runtime.json`               | `70b2647ac77c0e58b5fcb9377b341843d360ba5fc76fa04fa0ab3ee7223e2cc0` |
| `ios-libcurl-d2c0010c/summary.json`               | `6f20feadd29c1ab887a37b570984b733b118c64ec1e3284168818c51ca83a4bb` |
| `ios-libcurl-d2c0010c/witness.json`               | `80c3176ad9b28ac74ff42482dc7b1cb291e49fec9e6cbd422a7b70d13c34e72e` |
| `ios-standard-45071469429/build-diagnostics.json` | `3655d1041ff322a07f98a6a810642573ab43bd40a30e863166ccb389770affd0` |
| `ios-standard-45071469429/environment.json`       | `6aa70d91d66c839019d42e4c99ab6ace0035b562575990a27af701115adce721` |
| `ios-standard-45071469429/provenance.json`        | `9b61510c034777942d9a4afab36c25e472020fb9a92279f097f3b70582424b91` |
| `ios-standard-45071469429/release.json`           | `f022666c629bb5dd932236ea3438c875d77cd5e053d026f7ba08d0c4d6b3573b` |
| `ios-standard-45071469429/report.json`            | `0eb78d08816b69c5cc922a2544a38d56cee1ef284f77e055cc720d6357b08380` |
| `ios-standard-runtime-45255963304/report.json`    | `ce35a6884791fd417d364ac6717fceba34dcb17b3cccb8230a5024f360729df4` |

## Documents consolidés

Le contenu des sept fichiers ci-dessous a été comparé octet pour octet à l’export source de la révision `9a181a3c74e869a3f85022dc5c4efa5ed80a6f6b`, également couverte par le bundle. Dans la copie isolée restaurée à cette révision, ouvrir `docs/development/<fichier>` pour retrouver le document complet, ses inventaires et les résultats historiques.

| Ancien fichier                          | Référence actuelle                                                   | Informations préservées                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `monorepo-audit.md`                     | [architecture-overview.md](../architecture/architecture-overview.md) | Graphe des dépendances, rôle des contrats et de Zod, typage et exports, résolution Metro et limites des contrôles statiques.      |
| `backend-architecture-harmonization.md` | [architecture-overview.md](../architecture/architecture-overview.md) | Composition Nest, fournisseur PostgreSQL unique, politiques et ordre des gardes, routage historique et couverture.                |
| `android-https-memory-audit.md`         | [native-https-foundation.md](native-https-foundation.md)             | Récupération mémoire partielle, copies et attribution Hermes, absence de preuve sur la fuite et limites de l’instrumentation.     |
| `email-registration.md`                 | [http-email-registration.md](http-email-registration.md)             | Modèle d’intention et d’identité vérifiée, politique ASCII et mot de passe, migrations, frontières de confiance et reprises.      |
| `persistent-sessions.md`                | [http-sessions.md](http-sessions.md)                                 | Jeton s1, conservation, expiration et verrouillage, API interne et différence entre session et autorisation.                      |
| `initial-device-bootstrap.md`           | [http-initial-device-bootstrap.md](http-initial-device-bootstrap.md) | Éligibilité historique, association immuable, risque du premier appareil, atomicité, relecture et absence de reprise automatique. |
| `crypto-fix-001-audit.md`               | [threat-model.md](../security/threat-model.md)                       | CRYPTO-012, limites d’import et de transfert, fraîcheur et libellé des preuves de tests.                                          |

Les résumés `native-https-transport.md` et `native-https-transport-evaluation.md` ont été retirés après vérification de leur contenu. Le bundle conserve leurs versions historiques substantielles. La référence HTTPS regroupe le choix des transports, les preuves actives et les résultats mémoire. L’ADR-004 définit le contrat applicatif. [Référence HTTPS](native-https-foundation.md), [ADR-004](../architecture/decisions/004-bounded-mobile-api-responses.md)
