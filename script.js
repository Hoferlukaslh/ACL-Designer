// ==========================================
// 1. INITIALISATION ET VARIABLES GLOBALES
// ==========================================
mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });

let networks = [
    { id: "any", name: "Any (Internet)", ip: "any", wildcard: "" },
    { id: "10", name: "Serveurs", ip: "192.168.10.0", wildcard: "0.0.0.255" }
];

let interfaces = [
    { id: "int_any", name: "GigabitEthernet0/0", description: "WAN Internet" }
];

let acls = [];
let activeAclId = null;
let editingVlanId = null;
let editingInterfaceId = null;
let editingRuleIndex = null;

let panZoomInstance = null;
let activeMermaidTab = 'current'; 
let currentMermaidLayout = 'LR'; 
let lastMermaidSvgString = ""; 

window.onload = () => {
    loadFromBrowser();
    migrateDataIfNeeded();
    updateUI();
    updatePortState();
};

window.addEventListener('resize', () => {
    if (panZoomInstance) {
        panZoomInstance.resize();
        panZoomInstance.fit();
        panZoomInstance.center();
    }
});

// ==========================================
// 2. UTILITAIRES DE SÉCURITÉ
// ==========================================

// Échappe les caractères HTML pour prévenir les injections XSS dans innerHTML
function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Échappe les guillemets et sauts de ligne dans les labels Mermaid
// pour éviter de casser la syntaxe du graphe
function escapeMermaidLabel(s) {
    return String(s || '').replace(/"/g, '#quot;').replace(/\n/g, ' ');
}

// ==========================================
// 3. LOGIQUE DE MASQUE & MIGRATION V3
// ==========================================
function validateWildcard(ip, wildcard) {
    if(ip === "any" || ip === "0.0.0.0") return true;
    if(wildcard === "0.0.0.0") return true; // Hôte unique

    let ipParts = ip.split('.').map(Number);
    let wildParts = wildcard.split('.').map(Number);
    if(ipParts.length !== 4 || wildParts.length !== 4) return false;

    for (let i = 0; i < 4; i++) {
        // Validation mathématique : on s'assure que les bits d'hôtes sont bien à zéro dans l'adresse réseau
        if ((ipParts[i] & ~wildParts[i]) !== ipParts[i]) {
            return false;
        }
    }
    return true;
}

function migrateDataIfNeeded() {
    acls.forEach(acl => {
        let currentSeq = 10;
        acl.rules.forEach(r => {
            if (!r.seq) { r.seq = currentSeq; currentSeq += 10; }
            if (r.established === undefined) r.established = false;
            if (r.log === undefined) r.log = false;
            if (r.logInput === undefined) r.logInput = false;
            if (r.fragments === undefined) r.fragments = false;
            
            // Nettoyage des anciens opérateurs pour ICMP
            if(r.proto === 'icmp' && ['eq', 'lt', 'gt', 'neq'].includes(r.operator)) {
                r.operator = ""; 
            }
        });
        // S'assurer que les règles sont triées par numéro de séquence
        acl.rules.sort((a, b) => a.seq - b.seq);
    });
}

function saveToBrowser() {
    localStorage.setItem('acl_designer_multi_acl_v3', JSON.stringify({ networks, interfaces, acls, activeAclId }));
}

function loadFromBrowser() {
    try {
        const saved = localStorage.getItem('acl_designer_multi_acl_v3') 
                   || localStorage.getItem('acl_designer_multi_acl_v2');
        if (!saved) return;
        const data = JSON.parse(saved);
        // Valider que les champs attendus sont bien des tableaux
        if (Array.isArray(data.networks)) networks = data.networks;
        if (Array.isArray(data.interfaces)) interfaces = data.interfaces;
        if (Array.isArray(data.acls)) acls = data.acls;
        activeAclId = data.activeAclId || (acls.length > 0 ? acls[0].id : null);
    } catch (e) {
        console.error("Données locales corrompues, réinitialisation.", e);
        localStorage.removeItem('acl_designer_multi_acl_v3');
    }
}

function validateIpFormat(ip) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
        ip.split('.').every(o => { const n = parseInt(o); return n >= 0 && n <= 255; });
}

function validatePort(val) {
    const n = parseInt(val, 10);
    return !isNaN(n) && n >= 0 && n <= 65535 && String(n) === val.trim();
}

// ==========================================
// 4. PARSEUR IOS (INGÉNIERIE INVERSE)
// ==========================================
function openIosImport() {
    if(!confirm("⚠️ L'importation écrasera le projet actuel.\nContinuer ?")) return;
    document.getElementById('ios-import-modal').style.display = 'flex';
}

function closeIosImport() {
    document.getElementById('ios-import-modal').style.display = 'none';
    document.getElementById('ios-text').value = "";
}

function processIosImport() {
    const text = document.getElementById('ios-text').value;
    if(!text.trim()) return;

    let newNetworks = [{ id: "any", name: "Any (Internet)", ip: "any", wildcard: "" }];
    let newInterfaces = [];
    let newAcls = [];
    let currentAcl = null;
    let currentInterfaceId = null;
    let commentBuffer = "";

    function getOrCreateNetwork(ipStr) {
        if(!ipStr || ipStr === "any") return { id: "any", remaining: "" };
        let ip = ""; let wild = ""; let remaining = "";
        let parts = ipStr.trim().split(/\s+/);
        if (parts.length === 0) return { id: "any", remaining: "" };

        if(parts[0] === "host") {
            ip = parts[1]; wild = "0.0.0.0"; remaining = parts.slice(2).join(" ");
        } else if (parts[0] === "any") {
            return { id: "any", remaining: parts.slice(1).join(" ") };
        } else {
            ip = parts[0]; wild = parts[1] || "0.0.0.0"; remaining = parts.slice(2).join(" ");
        }

        let existing = newNetworks.find(n => n.ip === ip && n.wildcard === wild);
        if(existing) return { id: existing.id, remaining: remaining };

        let id = "net_" + Math.floor(Math.random()*10000);
        let name = wild === "0.0.0.0" ? "Hôte " + ip : "Réseau " + ip;
        newNetworks.push({ id, name, ip, wildcard: wild });
        return { id, remaining };
    }

    let lines = text.split('\n');
    for(let i=0; i<lines.length; i++) {
        let line = lines[i].trim();
        if(!line || line === "!") { commentBuffer = ""; continue; }

        if(line.startsWith("remark ")) { commentBuffer = line.substring(7).trim(); continue; }
        if(line.startsWith("! ")) { commentBuffer = line.substring(2).trim(); continue; }

        let aclMatch = line.match(/^ip access-list extended\s+(\S+)/);
        if(aclMatch) {
            currentAcl = { id: "acl_" + Date.now() + "_" + Math.floor(Math.random()*1000), name: aclMatch[1], targets: [], rules: [] };
            newAcls.push(currentAcl);
            currentInterfaceId = null; continue;
        }

        let ruleMatch = line.match(/^(\d+)?\s*(permit|deny)\s+([a-zA-Z0-9]+)\s+(.+)/);
        if(ruleMatch && currentAcl) {
            let seq = ruleMatch[1] ? parseInt(ruleMatch[1]) : (currentAcl.rules.length * 10 + 10);
            let action = ruleMatch[2];
            let proto = ruleMatch[3].toLowerCase();
            let rest = ruleMatch[4];

            let established = false; let log = false; let logInput = false; let fragments = false;
            
            if(rest.includes(" log-input")) { logInput = true; rest = rest.replace(" log-input", ""); }
            if(rest.includes(" log")) { log = true; rest = rest.replace(" log", ""); }
            if(rest.includes(" established")) { established = true; rest = rest.replace(" established", ""); }
            if(rest.includes(" fragments")) { fragments = true; rest = rest.replace(" fragments", ""); }

            let srcParsed = getOrCreateNetwork(rest); let srcId = srcParsed.id; rest = srcParsed.remaining;
            let dstParsed = getOrCreateNetwork(rest); let dstId = dstParsed.id; rest = dstParsed.remaining;

            let operator = "eq"; let portStart = ""; let portEnd = "";

            if(rest && rest.trim() !== "") {
                let portParts = rest.trim().split(/\s+/);
                if(proto === "icmp") {
                    operator = ""; portStart = portParts.join(" "); 
                } else if(portParts[0] === "range") {
                    operator = "range"; portStart = portParts[1] || ""; portEnd = portParts[2] || "";
                } else if(["eq", "gt", "lt", "neq"].includes(portParts[0])) {
                    operator = portParts[0]; portStart = portParts[1] || "";
                } else {
                    portStart = portParts[0];
                }
            } else if(proto !== 'tcp' && proto !== 'udp') { operator = ""; }

            currentAcl.rules.push({ seq, comment: commentBuffer, action, proto, srcId, dstId, operator, portStart, portEnd, established, log, logInput, fragments });
            commentBuffer = ""; continue;
        }

        let intMatch = line.match(/^interface\s+(.+)/i);
        if(intMatch) {
            currentAcl = null; let intName = intMatch[1].trim();
            let existingInt = newInterfaces.find(int => int.name.toLowerCase() === intName.toLowerCase());
            if(existingInt) { currentInterfaceId = existingInt.id; } 
            else {
                let newId = "int_" + Date.now() + "_" + Math.floor(Math.random()*1000);
                newInterfaces.push({ id: newId, name: intName, description: "" });
                currentInterfaceId = newId;
            }
            continue;
        }
        
        let descMatch = line.match(/^description\s+(.+)/i);
        if(descMatch && currentInterfaceId) {
            let intObj = newInterfaces.find(i => i.id === currentInterfaceId);
            if(intObj) intObj.description = descMatch[1].trim(); continue;
        }

        let groupMatch = line.match(/^ip access-group\s+(\S+)\s+(in|out)/i);
        if(groupMatch && currentInterfaceId) {
            let targetAcl = newAcls.find(a => a.name === groupMatch[1]);
            if(targetAcl && !targetAcl.targets.find(t => t.id === currentInterfaceId)) {
                targetAcl.targets.push({ id: currentInterfaceId, dir: groupMatch[2].toLowerCase() });
            }
        }
    }

    networks = newNetworks; interfaces = newInterfaces; acls = newAcls;
    activeAclId = acls.length > 0 ? acls[0].id : null;
    saveToBrowser(); updateUI(); updatePortState(); closeIosImport();
}

// ==========================================
// 5. ETATS UI & GESTION DES CHAMPS DYNAMIQUES
// ==========================================
function clearProject() {
    if(!confirm("⚠️ ATTENTION : ACTION IRRÉVERSIBLE ⚠️\n\nVoulez-vous vraiment TOUT effacer ?")) return;

    document.getElementById('import-file').value = "";
    networks = [{ id: "any", name: "Any (Internet)", ip: "any", wildcard: "" }];
    interfaces = [{ id: "int_any", name: "GigabitEthernet0/0", description: "Interface Internet" }];
    acls = []; activeAclId = null;
    editingVlanId = null; editingInterfaceId = null; editingRuleIndex = null;
    
    resetVlanForm(); resetInterfaceForm();
    if (document.getElementById('rule-form-container').classList.contains('editing-mode')) cancelRuleEdit();
    
    updateUI(); updatePortState(); saveToBrowser();
}

function updatePortState() {
    const proto = document.getElementById('rule-proto').value;
    const groupOperator = document.getElementById('group-operator');
    const operatorSelect = document.getElementById('rule-operator');
    const portStart = document.getElementById('rule-port-start');
    const portEnd = document.getElementById('rule-port-end');
    const rangeSeparator = document.getElementById('range-separator');
    const labelPort = document.getElementById('label-port');
    const estCheck = document.getElementById('rule-established');

    // Réinitialisation par défaut
    groupOperator.style.display = 'block';
    portStart.disabled = false; 
    operatorSelect.disabled = false;
    estCheck.disabled = true; 
    if(proto !== 'tcp') estCheck.checked = false;

    if (['ip', 'ospf', 'eigrp', 'esp'].includes(proto)) {
        groupOperator.style.display = 'none'; 
        portStart.disabled = true; 
        portStart.value = '';
        portStart.placeholder = "Non applicable"; 
        portEnd.style.display = 'none'; 
        rangeSeparator.style.display = 'none';
        labelPort.innerText = "Options L4";
    } else if (proto === 'icmp') {
        groupOperator.style.display = 'none'; // Pas d'opérateurs pour ICMP
        portStart.placeholder = "Message ICMP (ex: echo-reply)";
        portEnd.style.display = 'none'; 
        rangeSeparator.style.display = 'none';
        labelPort.innerText = "Type / Code ICMP";
    } else { // TCP / UDP
        labelPort.innerText = "Port (L4)";
        if(proto === 'tcp') estCheck.disabled = false;
        portStart.placeholder = "Ex: 80";
        if(operatorSelect.value === 'range') {
            portEnd.style.display = 'inline-block'; 
            rangeSeparator.style.display = 'inline-block';
        } else {
            portEnd.style.display = 'none'; 
            rangeSeparator.style.display = 'none';
        }
    }
}

// ==========================================
// 6. GESTION DES RÉSEAUX ET VALIDATION WILDCARD
// ==========================================
function saveVlan() {
    const id = document.getElementById('vlan-id').value.trim();
    const name = document.getElementById('vlan-name').value.trim();
    const ip = document.getElementById('vlan-ip').value.trim();
    const wild = document.getElementById('vlan-wild').value.trim();

    // Validation IP/Wildcard
    if(!id || !name || !ip) return alert("Champs incomplets");
    if (ip !== 'any' && !validateIpFormat(ip)) return alert("Format IP invalide.");
    if (wild && !validateIpFormat(wild)) return alert("Format wildcard invalide.");

    if(!validateWildcard(ip, wild)) {
        if(!confirm(`⚠️ L'adresse réseau ${ip} et le masque ${wild} semblent mathématiquement incohérents (bits d'hôtes non nuls dans la définition réseau). Voulez-vous vraiment forcer cette sauvegarde ?`)) {
            return;
        }
    }

    if (editingVlanId) {
        const index = networks.findIndex(n => n.id === editingVlanId);
        if (editingVlanId !== id) {
            acls.forEach(acl => {
                acl.rules.forEach(r => { if (r.srcId === editingVlanId) r.srcId = id; if (r.dstId === editingVlanId) r.dstId = id; });
            });
        }
        networks[index] = { id, name, ip, wildcard: wild }; editingVlanId = null;
    } else {
        if(networks.find(n => n.id === id)) return alert("ID déjà existant");
        networks.push({ id, name, ip, wildcard: wild });
    }
    resetVlanForm(); updateUI(); saveToBrowser();
}

function editVlan(id) {
    const net = networks.find(n => n.id === id); editingVlanId = id;
    document.getElementById('vlan-id').value = net.id; document.getElementById('vlan-name').value = net.name;
    document.getElementById('vlan-ip').value = net.ip; document.getElementById('vlan-wild').value = net.wildcard;
    document.getElementById('vlan-form-container').classList.add('editing-mode');
    document.getElementById('btn-add-vlan').innerText = "Mettre à jour"; document.getElementById('btn-cancel-vlan').style.display = "inline-block";
}

function cancelVlanEdit() { editingVlanId = null; resetVlanForm(); }

function resetVlanForm() {
    document.getElementById('vlan-id').value = ""; document.getElementById('vlan-name').value = ""; 
    document.getElementById('vlan-ip').value = ""; document.getElementById('vlan-wild').value = "0.0.0.255"; 
    document.getElementById('vlan-form-container').classList.remove('editing-mode'); 
    document.getElementById('btn-add-vlan').innerText = "+ Enregistrer Réseau"; document.getElementById('btn-cancel-vlan').style.display = "none"; 
}

function deleteVlan(id) { 
    if(confirm("Supprimer ce réseau ? Les règles associées seront corrompues ou supprimées.")) { 
        networks = networks.filter(n => n.id !== id); 
        acls.forEach(acl => { acl.rules = acl.rules.filter(r => r.srcId !== id && r.dstId !== id); }); 
        updateUI(); saveToBrowser(); 
    } 
}

function renderVlanList() {
    const container = document.getElementById('vlan-list-container'); container.innerHTML = "";
    networks.forEach(n => {
        if(n.id === "any") return;
        const div = document.createElement('div'); div.className = "list-item";

        const infoSpan = document.createElement('span');
        infoSpan.innerHTML = `<strong>${escapeHtml(n.id)}</strong>: ${escapeHtml(n.name)} (${escapeHtml(n.ip)})`;

        const actionsDiv = document.createElement('div'); actionsDiv.className = "item-actions";

        const btnEdit = document.createElement('button');
        btnEdit.className = "dark"; btnEdit.style.cssText = "padding:2px 8px; font-size:0.7rem;";
        btnEdit.textContent = "Éditer";
        btnEdit.addEventListener('click', () => editVlan(n.id));

        const btnDel = document.createElement('button');
        btnDel.className = "danger"; btnDel.style.cssText = "padding:2px 8px; font-size:0.7rem;";
        btnDel.textContent = "X";
        btnDel.addEventListener('click', () => deleteVlan(n.id));

        actionsDiv.appendChild(btnEdit); actionsDiv.appendChild(btnDel);
        div.appendChild(infoSpan); div.appendChild(actionsDiv);
        container.appendChild(div);
    });
}

// ==========================================
// 6.5 GESTION DES INTERFACES (CIBLES)
// ==========================================
function saveInterface() {
    const name = document.getElementById('int-name').value.trim(); const desc = document.getElementById('int-desc').value.trim();
    if(!name) return alert("Le nom de l'interface est requis.");
    
    if (editingInterfaceId) { 
        const index = interfaces.findIndex(i => i.id === editingInterfaceId); 
        interfaces[index] = { id: editingInterfaceId, name, description: desc }; 
        editingInterfaceId = null; 
    } else { 
        interfaces.push({ id: "int_" + Date.now(), name, description: desc }); 
    }
    resetInterfaceForm(); updateUI(); saveToBrowser();
}

function editInterface(id) { 
    const intf = interfaces.find(i => i.id === id); editingInterfaceId = id; 
    document.getElementById('int-name').value = intf.name; document.getElementById('int-desc').value = intf.description || ""; 
    document.getElementById('interface-form-container').classList.add('editing-mode'); 
    document.getElementById('btn-add-int').innerText = "Mettre à jour"; document.getElementById('btn-cancel-int').style.display = "inline-block"; 
}

function cancelInterfaceEdit() { editingInterfaceId = null; resetInterfaceForm(); }

function resetInterfaceForm() { 
    document.getElementById('int-name').value = ""; document.getElementById('int-desc').value = ""; 
    document.getElementById('interface-form-container').classList.remove('editing-mode'); 
    document.getElementById('btn-add-int').innerText = "+ Enregistrer Interface"; document.getElementById('btn-cancel-int').style.display = "none"; 
}

function deleteInterface(id) { 
    if(confirm("Supprimer interface ?")) { 
        interfaces = interfaces.filter(i => i.id !== id); 
        acls.forEach(acl => { acl.targets = acl.targets.filter(t => t.id !== id); }); 
        updateUI(); saveToBrowser(); 
    } 
}

function renderInterfaceList() {
    const container = document.getElementById('interface-list-container'); container.innerHTML = "";
    interfaces.forEach(i => {
        const div = document.createElement('div'); div.className = "list-item";

        const infoSpan = document.createElement('span');
        infoSpan.innerHTML = `<strong>${escapeHtml(i.name)}</strong>`
            + (i.description ? `<span style="color:#777; font-size:0.8em;"> - ${escapeHtml(i.description)}</span>` : '');

        const actionsDiv = document.createElement('div'); actionsDiv.className = "item-actions";

        const btnEdit = document.createElement('button');
        btnEdit.className = "dark"; btnEdit.style.cssText = "padding:2px 8px; font-size:0.7rem;";
        btnEdit.textContent = "Éditer";
        btnEdit.addEventListener('click', () => editInterface(i.id));

        const btnDel = document.createElement('button');
        btnDel.className = "danger"; btnDel.style.cssText = "padding:2px 8px; font-size:0.7rem;";
        btnDel.textContent = "X";
        btnDel.addEventListener('click', () => deleteInterface(i.id));

        actionsDiv.appendChild(btnEdit); actionsDiv.appendChild(btnDel);
        div.appendChild(infoSpan); div.appendChild(actionsDiv);
        container.appendChild(div);
    });
}

// ==========================================
// 7. GESTION DES ACLS ET RÈGLES
// ==========================================
function getActiveAcl() { return acls.find(a => a.id === activeAclId); }

function createNewAcl() { 
    const newId = "acl_" + Date.now(); 
    acls.push({ id: newId, name: "NEW_ACL", targets: [], rules: [] }); 
    activeAclId = newId; 
    cancelRuleEdit(); updateUI(); saveToBrowser(); 
}

function deleteActiveAcl() { 
    if(!confirm("Supprimer ACL ?")) return; 
    acls = acls.filter(a => a.id !== activeAclId); 
    activeAclId = acls.length > 0 ? acls[0].id : null; 
    cancelRuleEdit(); updateUI(); saveToBrowser(); 
}

function changeActiveAcl() { activeAclId = document.getElementById('acl-selector').value; cancelRuleEdit(); updateUI(); saveToBrowser(); }

function updateAclName() { 
    const activeAcl = getActiveAcl(); 
    if(activeAcl) { 
        activeAcl.name = document.getElementById('acl-custom-name').value
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9_\-\.]/g, '_') // Caractères IOS valides uniquement
            .substring(0, 64); // Limite IOS : 64 caractères

        generateOutput(); 
        document.querySelector(`#acl-selector option[value="${activeAcl.id}"]`).textContent = activeAcl.name; 
        saveToBrowser(); 
    } 
}

function toggleTarget(id) { 
    const activeAcl = getActiveAcl(); if(!activeAcl) return; 
    const idx = activeAcl.targets.findIndex(t => t.id === id); 
    if (idx > -1) activeAcl.targets.splice(idx, 1); 
    else activeAcl.targets.push({ id: id, dir: 'in' }); 
    updateUI(); saveToBrowser(); 
}

function updateTargetDirection(id, dir) { 
    const activeAcl = getActiveAcl(); 
    if(activeAcl) { 
        const t = activeAcl.targets.find(x => x.id === id); 
        if (t) { t.dir = dir; generateOutput(); saveToBrowser(); } 
    } 
}

function renderAclManager() {
    const selector = document.getElementById('acl-selector');
    const settingsBox = document.getElementById('active-acl-settings');
    selector.innerHTML = "";

    if (acls.length === 0) {
        selector.innerHTML = "<option>-- Aucune ACL --</option>";
        settingsBox.style.display = 'none';
        document.getElementById('rule-form-container').style.opacity = '0.5';
        document.getElementById('rule-form-container').style.pointerEvents = 'none';
        return;
    }

    document.getElementById('rule-form-container').style.opacity = '1';
    document.getElementById('rule-form-container').style.pointerEvents = 'auto';
    settingsBox.style.display = 'block';

    acls.forEach(acl => {
        const opt = document.createElement('option');
        opt.value = acl.id; opt.textContent = acl.name;
        selector.appendChild(opt);
    });

    selector.value = activeAclId;
    const activeAcl = getActiveAcl();
    if (activeAcl) {
        document.getElementById('acl-custom-name').value = activeAcl.name;
        renderTargetCheckboxes(activeAcl);
    }
}

function renderTargetCheckboxes(activeAcl) {
    const container = document.getElementById('target-interface-list'); container.innerHTML = "";
    interfaces.forEach(i => {
        const targetData = activeAcl.targets.find(t => t.id === i.id);
        const isChecked = !!targetData;
        const currentDir = targetData ? targetData.dir : 'in';

        const div = document.createElement('div'); div.className = "vlan-checkbox-group";

        // Label + checkbox
        const label = document.createElement('label');
        label.className = "vlan-checkbox";
        label.title = i.description || i.name;

        const checkbox = document.createElement('input');
        checkbox.type = "checkbox";
        checkbox.checked = isChecked;
        checkbox.addEventListener('change', () => toggleTarget(i.id));

        const labelText = document.createTextNode(i.name);
        label.appendChild(checkbox); label.appendChild(labelText);

        // Select direction
        const select = document.createElement('select');
        select.className = "dir-select";
        select.disabled = !isChecked;
        select.innerHTML = `<option value="in" ${currentDir === 'in' ? "selected" : ""}>IN</option>
                            <option value="out" ${currentDir === 'out' ? "selected" : ""}>OUT</option>`;
        select.addEventListener('change', () => updateTargetDirection(i.id, select.value));

        div.appendChild(label); div.appendChild(select);
        container.appendChild(div);
    });
}

function renderDropdowns() {
    const selects = [document.getElementById('rule-src'), document.getElementById('rule-dst')];
    const currentVals = selects.map(s => s.value);
    selects.forEach(s => s.innerHTML = "");

    networks.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n.id; opt.textContent = n.id === "any" ? n.name : `${n.id} - ${n.name}`;
        selects[0].appendChild(opt.cloneNode(true)); selects[1].appendChild(opt.cloneNode(true));
    });
    selects.forEach((s, i) => { if(currentVals[i]) s.value = currentVals[i]; });
}

function saveRule() {
    const activeAcl = getActiveAcl(); if(!activeAcl) return;

    const proto        = document.getElementById('rule-proto').value;
    const portStartVal = document.getElementById('rule-port-start').value.trim();
    const portEndVal   = document.getElementById('rule-port-end').value.trim();

    // Validation des ports TCP/UDP
    if (['tcp', 'udp'].includes(proto) && portStartVal) {
        if (!validatePort(portStartVal))
            return alert("Port invalide. Entrez un entier entre 0 et 65535.");
        if (document.getElementById('rule-operator').value === 'range' && portEndVal) {
            if (!validatePort(portEndVal))
                return alert("Port de fin invalide. Entrez un entier entre 0 et 65535.");
            if (parseInt(portEndVal) <= parseInt(portStartVal))
                return alert("Le port de fin doit être strictement supérieur au port de début.");
        }
    }

    let seqVal = document.getElementById('rule-seq').value;
    let seq = seqVal ? parseInt(seqVal) : (activeAcl.rules.length > 0 ? Math.max(...activeAcl.rules.map(r => r.seq)) + 10 : 10);

    const rule = {
        seq:      seq,
        comment:  document.getElementById('rule-comment').value.trim(),
        action:   document.getElementById('rule-action').value,
        proto:    proto,
        srcId:    document.getElementById('rule-src').value,
        dstId:    document.getElementById('rule-dst').value,
        operator: proto === 'icmp' ? "" : document.getElementById('rule-operator').value,
        portStart: portStartVal,
        portEnd:   portEndVal,
        established: document.getElementById('rule-established').checked,
        fragments:   document.getElementById('rule-fragments').checked,
        log:         document.getElementById('rule-log').checked,
        logInput:    document.getElementById('rule-log-input').checked
    };

    const seqExists = editingRuleIndex === null &&
                      activeAcl.rules.some(r => r.seq === seq);
    if (seqExists) return alert(`Le numéro de séquence ${seq} est déjà utilisé.`);

    if (editingRuleIndex !== null) { activeAcl.rules[editingRuleIndex] = rule; editingRuleIndex = null; }
    else { activeAcl.rules.push(rule); }

    activeAcl.rules.sort((a, b) => a.seq - b.seq);
    cancelRuleEdit(); updateUI(); saveToBrowser();
}

function editRule(index) {
    const activeAcl = getActiveAcl(); if(!activeAcl) return;
    const r = activeAcl.rules[index]; editingRuleIndex = index;
    
    document.getElementById('rule-seq').value = r.seq;
    document.getElementById('rule-comment').value = r.comment || "";
    document.getElementById('rule-action').value = r.action; 
    document.getElementById('rule-proto').value = r.proto;
    if(r.proto !== 'icmp') document.getElementById('rule-operator').value = r.operator || 'eq';
    updatePortState();

    document.getElementById('rule-src').value = r.srcId; 
    document.getElementById('rule-dst').value = r.dstId;
    document.getElementById('rule-port-start').value = r.portStart || ''; 
    document.getElementById('rule-port-end').value = r.portEnd || '';
    
    document.getElementById('rule-established').checked = r.established; 
    document.getElementById('rule-fragments').checked = r.fragments;
    document.getElementById('rule-log').checked = r.log; 
    document.getElementById('rule-log-input').checked = r.logInput;

    document.getElementById('rule-form-container').classList.add('editing-mode'); 
    document.getElementById('btn-add-rule').innerText = "Mettre à jour ACE"; 
    document.getElementById('btn-cancel-rule').style.display = "inline-block";
}

function cancelRuleEdit() {
    editingRuleIndex = null; 
    document.getElementById('rule-seq').value = ""; document.getElementById('rule-comment').value = ""; 
    document.getElementById('rule-port-start').value = ""; document.getElementById('rule-port-end').value = "";
    document.getElementById('rule-established').checked = false; document.getElementById('rule-fragments').checked = false; 
    document.getElementById('rule-log').checked = false; document.getElementById('rule-log-input').checked = false;
    
    updatePortState(); 
    document.getElementById('rule-form-container').classList.remove('editing-mode'); 
    document.getElementById('btn-add-rule').innerText = "+ Ajouter la règle"; 
    document.getElementById('btn-cancel-rule').style.display = "none";
}

function removeRule(index) { const activeAcl = getActiveAcl(); if(activeAcl) { activeAcl.rules.splice(index, 1); updateUI(); saveToBrowser(); } }

// ==========================================
// 8. GÉNÉRATION DE CODE IOS & RENDER TABLE
// ==========================================
function updateUI() {
    renderVlanList(); renderInterfaceList(); renderAclManager(); renderDropdowns(); renderTable(); generateOutput(); renderMermaidDiagram();
}

function getPortDisplayString(r) {
    if (['ip', 'ospf', 'eigrp', 'esp'].includes(r.proto)) return "-";
    if (r.proto === 'icmp') return escapeHtml(r.portStart) || "-";
    if (!r.portStart) return "-";
    if (r.operator === 'range' && r.portEnd) return `range ${escapeHtml(r.portStart)}-${escapeHtml(r.portEnd)}`;
    return `${escapeHtml(r.operator)} ${escapeHtml(r.portStart)}`;
}

function formatIPRule(net) {
    if (!net || net.id === "any") return "any";
    if (net.ip === "0.0.0.0" && net.wildcard === "255.255.255.255") return "any";
    if (net.wildcard === "0.0.0.0") return `host ${net.ip}`;
    return `${net.ip} ${net.wildcard}`;
}

// ==========================================
// MOTEUR D'ÉVALUATION SÉMANTIQUE 
// ==========================================
function isNetworkCovering(n1, n2) {
    if (!n1 || !n2) return false;
    if (n1.id === 'any') return true; // 'any' couvre n'importe quel réseau
    return n1.id === n2.id; // Simplification : identité stricte
}

function isPortCovering(r1, r2) {
    if (r1.proto === 'ip') return true; // IP englobe tous les protocoles/ports
    if (r1.proto !== r2.proto) return false;
    if (!r1.portStart) return true; // Aucun port spécifié = tous les ports couverts
    if (r1.operator === 'eq' && r2.operator === 'eq' && r1.portStart === r2.portStart) return true;
    return false;
}

function checkAclWarnings(activeAcl) {
    let warnings = [];
    let hasPermit = false;

    // Analyse Top-Down (de haut en bas)
    for (let i = 0; i < activeAcl.rules.length; i++) {
        let r1 = activeAcl.rules[i];
        if (r1.action === 'permit') hasPermit = true;

        let n1Src = networks.find(n => n.id === r1.srcId);
        let n1Dst = networks.find(n => n.id === r1.dstId);

        // Comparaison avec les règles situées EN DESSOUS
        for (let j = i + 1; j < activeAcl.rules.length; j++) {
            let r2 = activeAcl.rules[j];
            let n2Src = networks.find(n => n.id === r2.srcId);
            let n2Dst = networks.find(n => n.id === r2.dstId);

            let protoCovered = (r1.proto === 'ip' || r1.proto === r2.proto);
            let srcCovered = isNetworkCovering(n1Src, n2Src);
            let dstCovered = isNetworkCovering(n1Dst, n2Dst);
            let portCovered = isPortCovering(r1, r2);

            if (protoCovered && srcCovered && dstCovered && portCovered) {
                // r2.seq et r1.seq sont des entiers (parseInt), pas de risque XSS
                warnings.push({
                    type: 'warning',
                    msg: `⚠️ <strong>Ombrage (Rule Shadowing) :</strong> La séquence <strong>${r2.seq}</strong> ne sera jamais évaluée par le routeur car elle est totalement couverte par la séquence plus large <strong>${r1.seq}</strong>.`
                });
            }
        }
    }

    // Vérification du Implicit Deny All
    if (activeAcl.rules.length > 0 && !hasPermit) {
        warnings.push({
            type: 'danger',
            msg: `🚨 <strong>DANGER (Implicit Deny All) :</strong> Cette ACL ne contient aucune règle "permit". Par conséquent, la règle invisible finale de Cisco bloquera ABSOLUMENT TOUT le trafic.`
        });
    }

    return warnings;
}

// ==========================================
// RENDU DU TABLEAU 
// ==========================================
function renderTable() {
    const body = document.getElementById('rules-table-body'); body.innerHTML = "";
    const warningsContainer = document.getElementById('acl-warnings');
    
    const activeAcl = getActiveAcl();
    
    if(!activeAcl || activeAcl.rules.length === 0) { 
        body.innerHTML = `<tr><td colspan="7" class="empty-state">Aucune ACE configurée.</td></tr>`; 
        if(warningsContainer) warningsContainer.innerHTML = "";
        return; 
    }

    // Génération et affichage des alertes sémantiques
    if (warningsContainer) {
        warningsContainer.innerHTML = "";
        const warnings = checkAclWarnings(activeAcl);
        warnings.forEach(w => {
            const cssClass = w.type === 'danger' ? 'danger-alert' : 'warning-alert';
            warningsContainer.innerHTML += `<div class="${cssClass}">${w.msg}</div>`;
        });
    }

    // Affichage des règles
    activeAcl.rules.forEach((r, i) => {
        // Noms issus des données : échappement obligatoire
        const src = escapeHtml(networks.find(n => n.id === r.srcId)?.name || "Inconnu");
        const dst = escapeHtml(networks.find(n => n.id === r.dstId)?.name || "Inconnu");
        // Commentaire libre saisi par l'utilisateur : échappement obligatoire
        const comment = r.comment
            ? `<br><span style="color:#6a9955; font-size:0.8em;">! ${escapeHtml(r.comment)}</span>`
            : "";
        let flags = [];
        if(r.established) flags.push('<span class="badge badge-est">ESTABLISHED</span>');
        if(r.fragments) flags.push('<span class="badge badge-frag">FRAGMENTS</span>');
        if(r.logInput) flags.push('<span class="badge badge-log">LOG-INPUT</span>');
        else if(r.log) flags.push('<span class="badge badge-log">LOG</span>');
        const flagStr = flags.length > 0 ? `<br>${flags.join(" ")}` : "";

        // r.seq est un parseInt → sûr ; i est l'index du forEach → sûr
        body.innerHTML += `<tr>
            <td><strong>${r.seq}</strong></td>
            <td style="color:${r.action === 'permit' ? 'green' : 'red'}"><strong>${escapeHtml(r.action.toUpperCase())}</strong></td>
            <td>${escapeHtml(r.proto.toUpperCase())}</td><td>${src}</td><td>${dst}</td>
            <td>${getPortDisplayString(r)}${flagStr}${comment}</td> 
            <td>
                <button class="dark" onclick="editRule(${i})" style="padding:2px 8px;">Éditer</button> 
                <button class="danger" onclick="removeRule(${i})" style="padding:2px 8px;">X</button>
            </td>
        </tr>`;
    });
}

function generateOutput() {
    const output = document.getElementById('output-code');
    if (acls.length === 0) { output.innerHTML = "! Aucune ACL configurée."; return; }

    let code = "";
    acls.forEach(acl => {
        code += `<span class="comment-text">! ==========================================</span>\n`;
        // acl.name est sanitisé par updateAclName() mais on échappe en défense
        code += `<span class="keyword-text">ip access-list extended ${escapeHtml(acl.name)}</span>\n`;

        acl.rules.forEach(r => {
            if(r.comment) code += ` <span class="comment-text">remark ${escapeHtml(r.comment)}</span>\n`;
            
            const srcNet = networks.find(n => n.id === r.srcId);
            const dstNet = networks.find(n => n.id === r.dstId);
            
            let portStr = "";
            if (r.proto === 'icmp' && r.portStart) portStr = ` ${escapeHtml(r.portStart)}`;
            else if (['tcp', 'udp'].includes(r.proto) && r.portStart) {
                if (r.operator === 'range' && r.portEnd) portStr = ` range ${escapeHtml(r.portStart)} ${escapeHtml(r.portEnd)}`;
                else portStr = ` ${escapeHtml(r.operator)} ${escapeHtml(r.portStart)}`;
            }

            // formatIPRule retourne des IPs validées → sûres
            let line = `  ${r.seq} <span class="keyword-text">${escapeHtml(r.action)}</span> ${escapeHtml(r.proto)} ${formatIPRule(srcNet)} ${formatIPRule(dstNet)}${portStr}`;
            if(r.established) line += " established";
            if(r.fragments) line += " fragments";
            if(r.logInput) line += " log-input"; else if(r.log) line += " log";
            
            code += line + "\n";
        });
        code += ` exit\n<span class="comment-text">!</span>\n`;

        if (acl.targets.length > 0) {
            acl.targets.forEach(t => {
                const intObj = interfaces.find(i => i.id === t.id);
                if(intObj) {
                    code += `<span class="keyword-text">interface ${escapeHtml(intObj.name)}</span>\n`;
                    if(intObj.description) code += ` description ${escapeHtml(intObj.description)}\n`;
                    code += ` ip access-group ${escapeHtml(acl.name)} ${t.dir}\n<span class="comment-text">!</span>\n`;
                }
            });
        }
        code += "\n";
    });
    output.innerHTML = code;
}

// ==========================================
// 9. CARTE TOPOLOGIQUE & MERMAID
// ==========================================
function setMermaidTab(tab) {
    activeMermaidTab = tab;
    const btnCurrent = document.getElementById('tab-mermaid-current'); const btnAll = document.getElementById('tab-mermaid-all');
    if (tab === 'current') { btnCurrent.className = 'dark'; btnAll.className = 'outline'; } 
    else { btnCurrent.className = 'outline'; btnAll.className = 'dark'; }
    renderMermaidDiagram();
}

function toggleMermaidLayout() {
    const btn = document.getElementById('btn-mermaid-layout');
    if (currentMermaidLayout === 'LR') { currentMermaidLayout = 'TD'; btn.innerText = "🔄 Orientation : Verticale"; } 
    else { currentMermaidLayout = 'LR'; btn.innerText = "🔄 Orientation : Horizontale"; }
    renderMermaidDiagram();
}

async function renderMermaidDiagram() {
    const container = document.getElementById('mermaid-output');
    let rulesToRender = [];
    
    if (activeMermaidTab === 'current') {
        const activeAcl = getActiveAcl();
        if (!activeAcl || activeAcl.rules.length === 0) {
            container.innerHTML = "<span class='empty-state'>Aucune règle à afficher pour cette ACL.</span>";
            lastMermaidSvgString = ""; if (panZoomInstance) { panZoomInstance.destroy(); panZoomInstance = null; } return;
        }
        rulesToRender = activeAcl.rules.map(r => ({...r, aclName: ''}));
    } else {
        if (acls.length === 0) {
            container.innerHTML = "<span class='empty-state'>Aucune ACL configurée sur le projet.</span>";
            lastMermaidSvgString = ""; if (panZoomInstance) { panZoomInstance.destroy(); panZoomInstance = null; } return;
        }
        acls.forEach(acl => { acl.rules.forEach(r => { rulesToRender.push({...r, aclName: acl.name}); }); });
        if (rulesToRender.length === 0) {
            container.innerHTML = "<span class='empty-state'>Aucune règle n'existe dans le projet global.</span>";
            lastMermaidSvgString = ""; if (panZoomInstance) { panZoomInstance.destroy(); panZoomInstance = null; } return;
        }
    }

    let graph = `graph ${currentMermaidLayout}\n`;
    networks.forEach(n => {
        let idNode = n.id === "any" ? "any_node" : "net_" + n.id;
        // escapeMermaidLabel évite que les guillemets dans les noms cassent la syntaxe du graphe
        let label = n.id === "any"
            ? "Internet (Any)"
            : `${escapeMermaidLabel(n.name)}<br/>${escapeMermaidLabel(n.ip)}`;
        graph += `    ${idNode}["${label}"]\n`;
    });

    let linkIndex = 0; let linkStyles = "";
    rulesToRender.forEach(r => {
        let srcNode = r.srcId === "any" ? "any_node" : "net_" + r.srcId;
        let dstNode = r.dstId === "any" ? "any_node" : "net_" + r.dstId;
        let icon = r.action === 'permit' ? '✅' : '❌';
        
        let portInfo = "";
        if (r.proto === 'icmp' && r.portStart) portInfo = ` ${escapeMermaidLabel(r.portStart)}`;
        else if (['tcp', 'udp'].includes(r.proto) && r.portStart) portInfo = ` ${escapeMermaidLabel(r.portStart)}`;

        let flagInfo = r.established ? " (Est)" : "";
        
        let aclPrefix = r.aclName ? `[${escapeMermaidLabel(r.aclName)}]<br/>` : '';
        let labelText = `${aclPrefix}${icon} ${r.proto.toUpperCase()}${portInfo}${flagInfo}`;

        graph += `    ${srcNode} -- "${labelText}" --> ${dstNode}\n`;
        linkStyles += `    linkStyle ${linkIndex} stroke:${r.action === 'permit' ? 'green' : 'red'},stroke-width:2px,color:${r.action === 'permit' ? 'green' : 'red'};\n`;
        linkIndex++;
    });

    graph += linkStyles;

    try {
        mermaid.mermaidAPI.reset();
        const uniqueId = 'mermaid-graph-' + Date.now();
        const { svg } = await mermaid.render(uniqueId, graph);
        lastMermaidSvgString = svg; container.innerHTML = svg;

        const svgElement = container.querySelector('svg');
        if (svgElement) {
            svgElement.style.width = '100%'; svgElement.style.height = '100%'; svgElement.style.maxWidth = 'none';
            if (panZoomInstance) panZoomInstance.destroy();
            panZoomInstance = svgPanZoom(svgElement, { zoomEnabled: true, controlIconsEnabled: true, fit: true, center: true, minZoom: 0.1, maxZoom: 10 });
        }
    } catch (error) {
        console.error("Erreur de rendu Mermaid", error);
        container.innerHTML = "<span style='color: red;'>Erreur lors de la création du diagramme.</span>";
    }
}

function downloadMermaidPng() {
    if (!lastMermaidSvgString) { alert("Aucun diagramme à exporter pour le moment."); return; }
    const tempDiv = document.createElement('div'); tempDiv.innerHTML = lastMermaidSvgString;
    const svgElement = tempDiv.querySelector('svg'); svgElement.style.backgroundColor = '#ffffff';

    let width = 1200; let height = 800; 
    if (svgElement.viewBox && svgElement.viewBox.baseVal) {
        width = svgElement.viewBox.baseVal.width || width; height = svgElement.viewBox.baseVal.height || height;
    }

    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const svgData = new XMLSerializer().serializeToString(svgElement);
    const img = new Image();
    
    img.onload = function() {
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, width, height);
        const a = document.createElement('a'); a.download = `Topologie_ACL_${activeMermaidTab}.png`; a.href = canvas.toDataURL('image/png'); a.click();
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
}

function toggleFullscreen() {
    const wrapper = document.getElementById('mermaid-output-wrapper');
    if (!document.fullscreenElement) wrapper.requestFullscreen().catch(err => alert(`Erreur: ${err.message}`));
    else document.exitFullscreen();
}

// ==========================================
// 10. EXPORT / IMPORT DE FICHIERS
// ==========================================
function exportConfigTxt() {
    const text = document.getElementById('output-code').innerText;
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `config_acl_complete.txt`; a.click();
}

function exportJson() {
    const data = JSON.stringify({ networks, interfaces, acls, activeAclId }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `projet_multi_acl.json`; a.click();
}

function importJson(event) {
    const file = event.target.files[0]; if(!file) return;
    const reader = new FileReader();

    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!Array.isArray(data.networks) || !Array.isArray(data.acls)) {
                return alert("Fichier JSON invalide ou corrompu.");
            }

            networks = data.networks;
            interfaces = Array.isArray(data.interfaces) ? data.interfaces : [];

            if (data.rules && !data.acls.length) {
                acls = [{ id: "migrated_acl", name: data.aclName || "ACL_MIGREE", targets: data.selectedTargets || [], rules: data.rules }];
                activeAclId = acls[0].id;
            } else {
                acls = data.acls;
                activeAclId = data.activeAclId || (acls.length > 0 ? acls[0].id : null);
            }

            migrateDataIfNeeded();
            updateUI();
            updatePortState();
            saveToBrowser();

        } catch (err) {
            alert("Erreur de lecture du fichier JSON : contenu invalide ou corrompu.");
        }
    };
    
    reader.readAsText(file);
}