# Documentation Technique : ACL Designer

# Table des matières

- [Présentation du Projet](#présentation-du-projet)
- [Bibliothèques et Dépendances](#bibliothèques-et-dépendances)
- [Structure des Données (État de l'Application)](#structure-des-données-état-de-lapplication)
  - [Les Réseaux (networks)](#les-réseaux-networks)
  - [Les ACLs (acls)](#les-acls-acls)
- [Logique et Composants du Code (script.js)](#logique-et-composants-du-code-scriptjs)
  - [Initialisation et Variables Globales](#initialisation-et-variables-globales)
  - [Migration et Stockage Local](#migration-et-stockage-local)
  - [Gestion des Importations IOS (Rétro-conception)](#gestion-des-importations-ios-rétro-conception)
  - [Gestion des Projets et de l'UI](#gestion-des-projets-et-de-lui)
  - [Gestion des ACLs](#gestion-des-acls)
  - [Gestion des VLANs / Réseaux](#gestion-des-vlans--réseaux)
  - [Gestion des Règles ACL](#gestion-des-règles-acl)
  - [Fonctions d'Affichage et UI](#fonctions-daffichage-et-ui)
  - [Carte Topologique et Mermaid](#carte-topologique-et-mermaid)
  - [Export / Import de Fichiers](#export--import-de-fichiers)
    
## Présentation du Projet
ACL Designer est une application web fonctionnant côté client. Elle permet aux administrateurs réseau de concevoir, gérer et visualiser visuellement des listes de contrôle d'accès (ACL) multiples, de générer la configuration Cisco IOS correspondante et de faire de la rétro-conception à partir d'une configuration existante.

L'application est divisée en trois fichiers distincts pour respecter les standards de développement web :
- `index.html` : Structure de la page, modales et interface utilisateur.
- `style.css` : Mise en page, variables de couleurs et design responsive.
- `script.js` : Logique métier, gestion de l'état, parsing IOS et génération de diagrammes.

## Bibliothèques et Dépendances
L'application s'appuie sur deux bibliothèques externes chargées via un CDN :

- Mermaid.js (mermaid.min.js) : Utilisé pour générer dynamiquement la carte topologique des flux réseau.
- SVG Pan Zoom (svg-pan-zoom.min.js) : Ajoute des contrôles interactifs (zoom, déplacement) au diagramme Mermaid généré.

## Structure des Données (État de l'Application)
L'état de l'application est conservé dans des variables globales en JavaScript et persisté dans le `localStorage` du navigateur.

### Les Réseaux (networks)
Un tableau d'objets représentant les VLANs ou hôtes enregistrés.
```json
[
  {
    "id": "10",
    "name": "Serveurs",
    "ip": "192.168.10.0",
    "wildcard": "0.0.0.255"
  }
]
```

### Les ACLs (acls)
Un tableau d'objets contenant les listes de contrôle d'accès, leurs cibles (interfaces d'application) et leurs règles.
```json
[
  {
    "id": "acl_1678901234",
    "name": "ACL_SERVEURS",
    "targets": [
      { "id": "10", "dir": "in" }
    ],
    "rules": [
      {
        "comment": "Autoriser Web",
        "action": "permit",
        "proto": "tcp",
        "srcId": "any",
        "dstId": "10",
        "operator": "eq",
        "portStart": "80",
        "portEnd": ""
      }
    ]
  }
]
```

## Logique et Composants du Code (script.js)
Le fichier JavaScript est divisé en 10 sections logiques :

### Initialisation et Variables Globales
Déclare les variables d'état (`networks`, `acls`, `activeAclId`, etc.) et initialise l'application au chargement de la page (`window.onload`). L'instance mermaid est initialisée avec le niveau de sécurité `loose` pour permettre un rendu personnalisé.

### Migration et Stockage Local
- saveToBrowser() / loadFromBrowser() : Sauvegarde et restaure l'état complet du projet (Réseaux et ACLs) dans le localStorage sous la clé acl_designer_multi_acl_v1. 
- migrateDataIfNeeded() : Fonction de rétrocompatibilité qui met à jour les anciens formats de règles (gestion des ports) vers la nouvelle structure intégrant les opérateurs (eq, gt, range).

### Gestion des Importations IOS (Rétro-conception)
Permet de transformer une configuration textuelle brute IOS en objets JavaScript exploitables par l'application.

- processIosImport() : Parse ligne par ligne le texte entré par l'utilisateur.
  - Détecte la création d'ACL (ip access-list extended).
  - Extrait les règles (permit/deny), détermine la source, la destination, les ports et convertit les IPs/wildcards en objets réseaux via getOrCreateNetwork().
  - Assigne les ACLs aux interfaces (interface VlanX -> ip access-group).

### Gestion des Projets et de l'UI
- clearProject() : Réinitialise l'application à son état d'origine (garde uniquement le réseau "Any") après confirmation de l'utilisateur.
- updatePortState() : Fonction dynamique qui active ou désactive les champs d'opérateurs et de ports dans l'éditeur de règle en fonction du protocole sélectionné (ex: désactive les ports si IP est sélectionné, affiche un seul champ pour ICMP, affiche deux champs pour une plage de ports).

### Gestion des ACLs
Fonctions permettant le cycle de vie d'une ACL.
- createNewAcl(), deleteActiveAcl(), changeActiveAcl() : Fonctions CRUD basiques pour naviguer entre les différentes ACLs du projet.
- toggleTarget(), updateTargetDirection() : Permet d'attacher une ACL à un ou plusieurs réseaux/VLANs et de définir le sens de filtrage (IN ou OUT).

### Gestion des VLANs / Réseaux
CRUD pour le registre des réseaux.
- saveVlan(), editVlan(), deleteVlan() : Permettent de gérer les réseaux. Lors de la modification de l'ID d'un VLAN existant, l'application met à jour en cascade toutes les règles (srcId, dstId) et cibles (targets) qui l'utilisaient.

### Gestion des Règles ACL
- saveRule(), editRule(), removeRule() : Ajoute, modifie ou supprime une règle au sein de l'ACL active.
- moveRuleUp(), moveRuleDown() : Gère l'ordre des règles (concept crucial pour le fonctionnement des ACLs où l'ordre de lecture définit les priorités).

### Fonctions d'Affichage et UI
Série de fonctions préfixées par render... chargées de rafraîchir le DOM.

- renderVlanList(), renderAclManager(), renderDropdowns(), renderTable() : Vident et regénèrent les éléments HTML en fonction de l'état actuel des données.
- generateOutput() : Compile les données JavaScript en syntaxe de ligne de commande Cisco IOS, prête à être copiée-collée sur un routeur ou switch de niveau 3.

### Carte Topologique et Mermaid
Gère la visualisation graphique du réseau.

- renderMermaidDiagram() : Transforme les règles de sécurité en syntaxe de diagramme Mermaid (graph LR ou graph TD). Génère les liens (edges) en fonction des actions (vert pour permit, rouge pour deny).
- Intègre svgPanZoom une fois le SVG Mermaid injecté dans le DOM pour permettre une navigation fluide au sein du diagramme.
- downloadMermaidPng() : Dessine le SVG généré sur un objet <canvas> HTML5 pour l'exporter et le télécharger au format image .png.

### Export / Import de Fichiers
- exportConfigTxt() : Télécharge le code généré IOS dans un fichier .txt.
- exportJson(), importJson(event) : Permet de télécharger l'état complet du projet (Réseaux + ACLs) sous forme de fichier .json et de le recharger plus tard.