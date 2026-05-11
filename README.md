# ACL Designer

**ACL Designer** est un outil web interactif tout-en-un (zéro installation) conçu pour simplifier la création, la gestion et la visualisation de Listes de Contrôle d'Accès (ACL) étendues pour les équipements Cisco IOS. 

Fini les erreurs de syntaxe et les plans réseau brouillons : dessinez vos règles, l'outil génère le code Cisco et cartographie votre topologie en temps réel !

![Aperçu du site](./Image/Site.png)

---

## ✨ Fonctionnalités Principales

* **Registre de Réseaux & VLANs :** Déclarez facilement vos réseaux (ID, Nom, IP, Masque générique/Wildcard).
* **Gestionnaire Multi-ACL :** Créez plusieurs ACLs, assignez-les à des VLANs spécifiques et définissez leur direction (IN/OUT).
* **Génération de configuration IOS :** L'outil compile en temps réel vos règles en syntaxe Cisco IOS valide (`ip access-list extended`, `permit/deny`, `interface Vlan`, `ip access-group`).
* **Cartographie Topologique Dynamique :** Visualisez instantanément l'impact de vos règles grâce à la génération de graphes **Mermaid.js**.
  * Affichage des règles d'une ACL spécifique ou de l'ensemble du projet.
  * Orientation horizontale (LR) ou verticale (TD).
  * **Navigation fluide :** Zoom à la molette, déplacement (pan) et mode Plein Écran intégrés.
  * **Exportation PNG :** Téléchargez votre topologie réseau en image HD d'un simple clic.
* **Rétro-conception IOS (Reverse Engineering) :** Collez un extrait de `show running-config` (ACLs et interfaces). L'outil l'analyse, recrée les réseaux manquants et dessine la carte topologique automatiquement !
* **Sauvegarde locale & JSON :** Vos données sont sauvegardées dans votre navigateur, avec possibilité d'exporter/importer des fichiers `.json`.

---

## Utilisation (Zéro Installation)

L'application est un simple fichier HTML statique. Aucun backend ni serveur lourd n'est requis.

1. Téléchargez le fichier `ACL_Designer.html`.
2. Ouvrez-le dans votre navigateur web préféré (Chrome, Firefox, Edge, etc.).

> **Note concernant la sécurité des navigateurs :** > Si vous ouvrez le fichier directement par un double-clic (`file:///...`), le navigateur pourrait bloquer la génération d'images Mermaid pour des raisons de sécurité strictes sur les fichiers locaux. 
> **Recommandation :** Utilisez une petite extension comme **Live Server** sur VS Code pour exécuter le fichier via un serveur local (`http://127.0.0.1:5500`), ce qui débloquera 100% des fonctionnalités d'exportation.

---

## Outils & Technologies Utilisées

* **HTML5 / CSS3 / JavaScript (Vanilla)** : Interface réactive, légère et sans framework complexe.
* **[Mermaid.js](https://mermaid.js.org/)** : Moteur de rendu puissant pour transformer les règles de pare-feu en diagrammes vectoriels.
* **[svg-pan-zoom](https://github.com/bumbu/svg-pan-zoom)** : Ajout des contrôles tactiles et de navigation (panoramique, zoom) sur la carte topologique.

---

## Comment utiliser la Rétro-conception (Import IOS) ?

Vous avez déjà un routeur ou un switch de cœur de réseau configuré et souhaitez le visualiser ?

1. Cliquez sur le bouton rouge **⚠️ Importer IOS**.
2. Collez vos commandes Cisco. L'outil supporte le format suivant :
```text
ip access-list extended ACL_SERVEURS
 permit tcp any host 192.168.15.10 eq 80
 deny ip 192.168.90.0 0.0.0.255 any
exit
!
interface Vlan10
 ip access-group ACL_SERVEURS in
```