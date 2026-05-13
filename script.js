// ==========================================
// 1. INITIALISATION ET VARIABLES GLOBALES
// ==========================================
mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });

let networks = [
    { id: "any", name: "Any (Internet)", ip: "any", wildcard: "" },
    { id: "10", name: "Serveurs", ip: "192.168.10.0", wildcard: "0.0.0.255" },
    { id: "20", name: "IoT", ip: "192.168.20.0", wildcard: "0.0.0.255" }
];

let acls = [
    { id: "acl_" + Date.now(), name: "ACL_SERVEURS", targets: [{id: "10", dir: "in"}], rules: [] }
];

let activeAclId = acls[0].id;
let editingVlanId = null;
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
// 2. MIGRATION ET STOCKAGE
// ==========================================
function migrateDataIfNeeded() {
    acls.forEach(acl => {
        if (acl.targets && acl.targets.length > 0) {
            acl.targets = acl.targets.map(t => {
                return (typeof t === 'string') ? { id: t, dir: 'in' } : t;
            });
        }
        acl.rules.forEach(r => {
            if(r.port !== undefined && typeof r.port === 'string' && !r.operator) {
                let oldPort = r.port.trim();
                if(oldPort === "") {
                     r.operator = "eq";
                     r.portStart = "";
                } else if(oldPort.startsWith("eq ") || oldPort.startsWith("gt ") || oldPort.startsWith("lt ") || oldPort.startsWith("neq ")) {
                     r.operator = oldPort.substring(0, oldPort.indexOf(' '));
                     r.portStart = oldPort.substring(oldPort.indexOf(' ')+1);
                } else if(oldPort.startsWith("range ")) {
                     r.operator = "range";
                     let parts = oldPort.substring(6).split(' ');
                     r.portStart = parts[0] || "";
                     r.portEnd = parts[1] || "";
                } else {
                    r.operator = "eq";
                    r.portStart = oldPort;
                }
                delete r.port; 
            }
        });
    });
}

function saveToBrowser() {
    localStorage.setItem('acl_designer_multi_acl_v1', JSON.stringify({ networks, acls, activeAclId }));
}

function loadFromBrowser() {
    const saved = localStorage.getItem('acl_designer_multi_acl_v1');
    if (saved) {
        const data = JSON.parse(saved);
        networks = data.networks || networks;
        acls = data.acls || acls;
        activeAclId = data.activeAclId || (acls.length > 0 ? acls[0].id : null);
    }
}

// ==========================================
// 3. GESTION DES IMPORTATIONS IOS
// ==========================================
function openIosImport() {
    if(!confirm("⚠️ ATTENTION ACTION DESTRUCTRICE ⚠️\n\nL'importation d'une configuration IOS va écraser TOUT votre projet actuel.\nVoulez-vous vraiment continuer ?")) return;
    document.getElementById('ios-import-modal').style.display = 'flex';
}

function closeIosImport() {
    document.getElementById('ios-import-modal').style.display = 'none';
    document.getElementById('ios-text').value = "";
}

function processIosImport() {
    const text = document.getElementById('ios-text').value;
    if(!text.trim()) return alert("Veuillez coller une configuration IOS dans la zone de texte.");

    let newNetworks = [{ id: "any", name: "Any (Internet)", ip: "any", wildcard: "" }];
    let newAcls = [];
    
    let lines = text.split('\n');
    let currentAcl = null;
    let currentInterface = null;
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
        let name = "Réseau " + ip;
        if(wild === "0.0.0.0") name = "Hôte " + ip;
        
        let octets = ip.split('.');
        if(octets.length === 4 && wild === "0.0.0.255") {
            let candidateId = octets[2];
            if(!newNetworks.find(n => n.id === candidateId)) {
                id = candidateId;
                name = "VLAN" + id;
            }
        }

        newNetworks.push({ id: id, name: name, ip: ip, wildcard: wild });
        return { id: id, remaining: remaining };
    }

    for(let i=0; i<lines.length; i++) {
        let line = lines[i].trim();
        if(!line || line === "!") { commentBuffer = ""; continue; }

        if(line.startsWith("remark ")) { commentBuffer = line.substring(7).trim(); continue; }
        if(line.startsWith("! ")) { commentBuffer = line.substring(2).trim(); continue; }

        let aclMatch = line.match(/^ip access-list extended\s+(\S+)/);
        if(aclMatch) {
            currentAcl = { id: "acl_" + Date.now() + "_" + Math.floor(Math.random()*1000), name: aclMatch[1], targets: [], rules: [] };
            newAcls.push(currentAcl);
            continue;
        }

        let ruleMatch = line.match(/^(permit|deny)\s+(ip|tcp|udp|icmp)\s+(.+)/);
        if(ruleMatch && currentAcl) {
            let action = ruleMatch[1];
            let proto = ruleMatch[2];
            let rest = ruleMatch[3];

            let srcParsed = getOrCreateNetwork(rest);
            let srcId = srcParsed.id;
            rest = srcParsed.remaining;

            let dstParsed = getOrCreateNetwork(rest);
            let dstId = dstParsed.id;
            rest = dstParsed.remaining;

            let operator = "eq"; let portStart = ""; let portEnd = "";

            if(rest && rest.trim() !== "") {
                let portParts = rest.trim().split(/\s+/);
                if(proto === "icmp") {
                    portStart = portParts.join(" "); 
                } else if(portParts[0] === "range") {
                    operator = "range"; portStart = portParts[1] || ""; portEnd = portParts[2] || "";
                } else if(["eq", "gt", "lt", "neq"].includes(portParts[0])) {
                    operator = portParts[0]; portStart = portParts[1] || "";
                } else {
                    portStart = portParts[0];
                }
            } else if(proto !== 'ip' && proto !== 'icmp') {
                operator = "eq";
            }

            currentAcl.rules.push({ comment: commentBuffer, action: action, proto: proto, srcId: srcId, dstId: dstId, operator: operator, portStart: portStart, portEnd: portEnd });
            commentBuffer = ""; 
            continue;
        }

        let intMatch = line.match(/^interface\s+(.+)/i);
        if(intMatch) {
            currentAcl = null; 
            let intName = intMatch[1];
            let vlanMatch = intName.match(/vlan\s*(\d+)/i);
            
            if(vlanMatch) {
                currentInterface = vlanMatch[1];
                if(!newNetworks.find(n => n.id === currentInterface)) {
                    newNetworks.push({ id: currentInterface, name: "VLAN" + currentInterface, ip: "0.0.0.0", wildcard: "0.0.0.255" });
                }
            } else {
                currentInterface = intName;
            }
            continue;
        }

        let groupMatch = line.match(/^ip access-group\s+(\S+)\s+(in|out)/i);
        if(groupMatch && currentInterface) {
            let aName = groupMatch[1];
            let dir = groupMatch[2].toLowerCase();
            let targetAcl = newAcls.find(a => a.name === aName);
            if(targetAcl && !targetAcl.targets.find(t => t.id === currentInterface)) {
                targetAcl.targets.push({ id: currentInterface, dir: dir });
            }
        }
    }

    networks = newNetworks;
    acls = newAcls;
    activeAclId = acls.length > 0 ? acls[0].id : null;

    saveToBrowser();
    updateUI();
    updatePortState();
    closeIosImport();
    alert("✅ Importation de la configuration IOS réussie ! Le projet a été reconstruit.");
}

// ==========================================
// 4. GESTION DES PROJETS & ETATS DE L'UI
// ==========================================
function clearProject() {
    if(!confirm("⚠️ ATTENTION : ACTION IRRÉVERSIBLE ⚠️\n\nVoulez-vous vraiment TOUT effacer ?")) return;

    document.getElementById('import-file').value = "";
    networks = [{ id: "any", name: "Any (Internet)", ip: "any", wildcard: "" }];
    acls = [];
    activeAclId = null;
    editingVlanId = null;
    editingRuleIndex = null;

    resetVlanForm();
    if (document.getElementById('rule-form-container').classList.contains('editing-mode')) cancelRuleEdit();

    updateUI();
    updatePortState();
    saveToBrowser();
}

function updatePortState() {
    const proto = document.getElementById('rule-proto').value;
    const operatorSelect = document.getElementById('rule-operator');
    const portStart = document.getElementById('rule-port-start');
    const portEnd = document.getElementById('rule-port-end');
    const rangeSeparator = document.getElementById('range-separator');
    const groupOperator = document.getElementById('group-operator');

    if (proto === 'ip') {
        groupOperator.style.display = 'block';
        operatorSelect.disabled = true;
        portStart.disabled = true;
        portStart.value = '';
        portStart.placeholder = "Invalide avec IP";
        portEnd.style.display = 'none';
        rangeSeparator.style.display = 'none';
    } else if (proto === 'icmp') {
        groupOperator.style.display = 'none';
        portStart.disabled = false;
        portStart.placeholder = "Message ICMP (ex: echo)";
        portEnd.style.display = 'none';
        rangeSeparator.style.display = 'none';
    } else {
        groupOperator.style.display = 'block';
        operatorSelect.disabled = false;
        portStart.disabled = false;
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
// 5. GESTION DES ACLS
// ==========================================
function getActiveAcl() {
    return acls.find(a => a.id === activeAclId);
}

function createNewAcl() {
    const newId = "acl_" + Date.now();
    acls.push({ id: newId, name: "NOUVELLE_ACL_" + (acls.length + 1), targets: [], rules: [] });
    activeAclId = newId;
    cancelRuleEdit();
    updateUI();
    saveToBrowser();
}

function deleteActiveAcl() {
    if(!confirm("Êtes-vous sûr de vouloir supprimer entièrement cette ACL ?")) return;
    acls = acls.filter(a => a.id !== activeAclId);
    activeAclId = acls.length > 0 ? acls[0].id : null;
    cancelRuleEdit();
    updateUI();
    saveToBrowser();
}

function changeActiveAcl() {
    activeAclId = document.getElementById('acl-selector').value;
    cancelRuleEdit();
    updateUI();
    saveToBrowser();
}

function updateAclName() {
    const activeAcl = getActiveAcl();
    if(activeAcl) {
        activeAcl.name = document.getElementById('acl-custom-name').value.trim().toUpperCase().replace(/\s+/g, '_');
        generateOutput();
        const option = document.querySelector(`#acl-selector option[value="${activeAcl.id}"]`);
        if(option) option.textContent = activeAcl.name;
        saveToBrowser();
    }
}

function toggleTarget(id) {
    const activeAcl = getActiveAcl();
    if(!activeAcl) return;

    const existingIndex = activeAcl.targets.findIndex(t => t.id === id);
    if (existingIndex > -1) {
        activeAcl.targets.splice(existingIndex, 1);
    } else {
        activeAcl.targets.push({ id: id, dir: 'in' });
    }
    updateUI();
    saveToBrowser();
}

function updateTargetDirection(id, direction) {
    const activeAcl = getActiveAcl();
    if(!activeAcl) return;

    const target = activeAcl.targets.find(t => t.id === id);
    if (target) {
        target.dir = direction;
        generateOutput();
        saveToBrowser();
    }
}

// ==========================================
// 6. GESTION DES VLANS / RESEAUX
// ==========================================
function saveVlan() {
    const id = document.getElementById('vlan-id').value.trim();
    const name = document.getElementById('vlan-name').value.trim();
    const ip = document.getElementById('vlan-ip').value.trim();
    const wild = document.getElementById('vlan-wild').value.trim();

    if(!id || !name || !ip) return alert("Champs incomplets");

    if (editingVlanId) {
        const index = networks.findIndex(n => n.id === editingVlanId);
        if (editingVlanId !== id) {
            acls.forEach(acl => {
                acl.rules.forEach(r => {
                    if (r.srcId === editingVlanId) r.srcId = id;
                    if (r.dstId === editingVlanId) r.dstId = id;
                });
                acl.targets.forEach(t => {
                    if(t.id === editingVlanId) t.id = id;
                });
            });
        }
        networks[index] = { id, name, ip, wildcard: wild };
        editingVlanId = null;
    } else {
        if(networks.find(n => n.id === id)) return alert("ID déjà existant");
        networks.push({ id, name, ip, wildcard: wild });
    }
    resetVlanForm();
    updateUI();
    saveToBrowser();
}

function editVlan(id) {
    const net = networks.find(n => n.id === id);
    editingVlanId = id;
    document.getElementById('vlan-id').value = net.id;
    document.getElementById('vlan-name').value = net.name;
    document.getElementById('vlan-ip').value = net.ip;
    document.getElementById('vlan-wild').value = net.wildcard;
    document.getElementById('vlan-form-title').innerText = "📝 Édition du réseau";
    document.getElementById('btn-add-vlan').innerText = "Mettre à jour";
    document.getElementById('btn-cancel-vlan').style.display = "inline-block";
    document.getElementById('vlan-form-container').classList.add('editing-mode');
}

function cancelVlanEdit() {
    editingVlanId = null;
    resetVlanForm();
}

function resetVlanForm() {
    document.getElementById('vlan-id').value = "";
    document.getElementById('vlan-name').value = "";
    document.getElementById('vlan-ip').value = "";
    document.getElementById('vlan-wild').value = "0.0.0.255";
    document.getElementById('vlan-form-title').innerText = "1. Registre des Réseaux";
    document.getElementById('btn-add-vlan').innerText = "+ Enregistrer Réseau";
    document.getElementById('btn-cancel-vlan').style.display = "none";
    document.getElementById('vlan-form-container').classList.remove('editing-mode');
}

function deleteVlan(id) {
    if(!confirm("Supprimer ? Les règles liées dans TOUTES les ACLs seront effacées.")) return;
    networks = networks.filter(n => n.id !== id);
    acls.forEach(acl => {
        acl.rules = acl.rules.filter(r => r.srcId !== id && r.dstId !== id);
        acl.targets = acl.targets.filter(t => t.id !== id);
    });
    updateUI();
    saveToBrowser();
}

// ==========================================
// 7. GESTION DES REGLES ACL
// ==========================================
function saveRule() {
    const activeAcl = getActiveAcl();
    if(!activeAcl) return alert("Veuillez d'abord créer ou sélectionner une ACL.");

    const rule = {
        comment: document.getElementById('rule-comment').value.trim(),
        action: document.getElementById('rule-action').value,
        proto: document.getElementById('rule-proto').value,
        srcId: document.getElementById('rule-src').value,
        dstId: document.getElementById('rule-dst').value,
        operator: document.getElementById('rule-operator').value,
        portStart: document.getElementById('rule-port-start').value.trim(),
        portEnd: document.getElementById('rule-port-end').value.trim()
    };

    if (editingRuleIndex !== null) {
        activeAcl.rules[editingRuleIndex] = rule;
        editingRuleIndex = null;
    } else {
        activeAcl.rules.push(rule);
    }
    cancelRuleEdit();
    updateUI();
    saveToBrowser();
}

function editRule(index) {
    const activeAcl = getActiveAcl();
    if(!activeAcl) return;

    const r = activeAcl.rules[index];
    editingRuleIndex = index;
    document.getElementById('rule-comment').value = r.comment;
    document.getElementById('rule-action').value = r.action;
    document.getElementById('rule-proto').value = r.proto;
    document.getElementById('rule-operator').value = r.operator || 'eq';

    updatePortState();

    document.getElementById('rule-src').value = r.srcId;
    document.getElementById('rule-dst').value = r.dstId;
    document.getElementById('rule-port-start').value = r.portStart || '';
    document.getElementById('rule-port-end').value = r.portEnd || '';

    document.getElementById('rule-form-title').innerText = "📝 Édition de la règle #" + (index + 1);
    document.getElementById('btn-add-rule').innerText = "Appliquer les modifications";
    document.getElementById('btn-cancel-rule').style.display = "inline-block";
    document.getElementById('rule-form-container').classList.add('editing-mode');
}

function cancelRuleEdit() {
    editingRuleIndex = null;
    document.getElementById('rule-comment').value = "";
    document.getElementById('rule-port-start').value = "";
    document.getElementById('rule-port-end').value = "";
    updatePortState();
    document.getElementById('rule-form-title').innerText = "3. Éditeur de Règle";
    document.getElementById('btn-add-rule').innerText = "+ Ajouter la règle";
    document.getElementById('btn-cancel-rule').style.display = "none";
    document.getElementById('rule-form-container').classList.remove('editing-mode');
}

function removeRule(index) {
    const activeAcl = getActiveAcl();
    if(activeAcl) {
        activeAcl.rules.splice(index, 1);
        updateUI();
        saveToBrowser();
    }
}

function moveRuleUp(index) {
    const activeAcl = getActiveAcl();
    if (activeAcl && index > 0) {
        const temp = activeAcl.rules[index];
        activeAcl.rules[index] = activeAcl.rules[index - 1];
        activeAcl.rules[index - 1] = temp;
        updateUI();
        saveToBrowser();
    }
}

function moveRuleDown(index) {
    const activeAcl = getActiveAcl();
    if (activeAcl && index < activeAcl.rules.length - 1) {
        const temp = activeAcl.rules[index];
        activeAcl.rules[index] = activeAcl.rules[index + 1];
        activeAcl.rules[index + 1] = temp;
        updateUI();
        saveToBrowser();
    }
}

// ==========================================
// 8. FONCTIONS D'AFFICHAGE ET UI
// ==========================================
function updateUI() {
    renderVlanList();
    renderAclManager();
    renderDropdowns();
    renderTable();
    generateOutput();
    renderMermaidDiagram();
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
        opt.value = acl.id;
        opt.textContent = acl.name;
        selector.appendChild(opt);
    });

    selector.value = activeAclId;

    const activeAcl = getActiveAcl();
    if (activeAcl) {
        document.getElementById('acl-custom-name').value = activeAcl.name;
        renderTargetCheckboxes(activeAcl);
    }
}

function renderVlanList() {
    const container = document.getElementById('vlan-list-container');
    container.innerHTML = "";
    networks.forEach(n => {
        if(n.id === "any") return;
        const div = document.createElement('div');
        div.className = "list-item";
        div.innerHTML = `
            <span><strong>ID ${n.id}</strong>: ${n.name} (${n.ip})</span>
            <div class="item-actions">
                <button class="dark" onclick="editVlan('${n.id}')" style="padding:2px 8px; font-size:0.7rem;">Éditer</button>
                <button class="danger" onclick="deleteVlan('${n.id}')" style="padding:2px 8px; font-size:0.7rem;">X</button>
            </div>
        `;
        container.appendChild(div);
    });
}

function renderTargetCheckboxes(activeAcl) {
    const container = document.getElementById('target-vlan-list');
    container.innerHTML = "";

    networks.forEach(n => {
        if(n.id === "any") return;

        const targetData = activeAcl.targets.find(t => t.id === n.id);
        const isChecked = !!targetData;
        const currentDir = targetData ? targetData.dir : 'in';

        const div = document.createElement('div');
        div.className = "vlan-checkbox-group";

        div.innerHTML = `
            <label class="vlan-checkbox">
                <input type="checkbox" ${isChecked ? "checked" : ""} onchange="toggleTarget('${n.id}')">
                ${n.id} - ${n.name}
            </label>
            <select class="dir-select" onchange="updateTargetDirection('${n.id}', this.value)" ${!isChecked ? "disabled" : ""}>
                <option value="in" ${currentDir === 'in' ? "selected" : ""}>IN</option>
                <option value="out" ${currentDir === 'out' ? "selected" : ""}>OUT</option>
            </select>
        `;
        container.appendChild(div);
    });
}

function renderDropdowns() {
    const selects = [document.getElementById('rule-src'), document.getElementById('rule-dst')];
    const currentVals = selects.map(s => s.value);
    selects.forEach(s => s.innerHTML = "");

    networks.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n.id;
        opt.textContent = n.id === "any" ? n.name : `VLAN${n.id} - ${n.name}`;
        selects[0].appendChild(opt.cloneNode(true));
        selects[1].appendChild(opt.cloneNode(true));
    });

    selects.forEach((s, i) => { if(currentVals[i]) s.value = currentVals[i]; });
}

function getPortDisplayString(r) {
    if (r.proto === 'ip') return "-";
    if (r.proto === 'icmp') return r.portStart || "-";
    if (!r.portStart) return "-";

    if (r.operator === 'range' && r.portEnd) {
        return `range ${r.portStart}-${r.portEnd}`;
    }
    return `${r.operator} ${r.portStart}`;
}

function renderTable() {
    const body = document.getElementById('rules-table-body');
    body.innerHTML = "";

    const activeAcl = getActiveAcl();
    if(!activeAcl || activeAcl.rules.length === 0) {
        body.innerHTML = `<tr><td colspan="7" class="empty-state">Aucune règle dans cette ACL</td></tr>`;
        return;
    }

    activeAcl.rules.forEach((r, i) => {
        const src = networks.find(n => n.id === r.srcId)?.name || "Inconnu";
        const dst = networks.find(n => n.id === r.dstId)?.name || "Inconnu";

        const commentDisplay = r.comment ? `<span style="color: #6a9955; font-size: 0.8rem;">${r.comment}</span>` : "-";
        const portDisplay = getPortDisplayString(r);

        const isFirst = i === 0;
        const isLast = i === activeAcl.rules.length - 1;

        body.innerHTML += `<tr>
            <td>${i+1}</td>
            <td style="color:${r.action === 'permit' ? 'green' : 'red'}"><strong>${r.action.toUpperCase()}</strong></td>
            <td>${src}</td>
            <td>${dst}</td>
            <td>${portDisplay}</td>
            <td>${commentDisplay}</td> 
            <td>
                <div class="item-actions">
                    <button class="outline" onclick="moveRuleUp(${i})" style="padding:2px 6px;" ${isFirst ? 'disabled' : ''} title="Monter">⬆️</button>
                    <button class="outline" onclick="moveRuleDown(${i})" style="padding:2px 6px;" ${isLast ? 'disabled' : ''} title="Descendre">⬇️</button>
                    <button class="dark" onclick="editRule(${i})" style="padding:2px 8px;">Éditer</button>
                    <button class="danger" onclick="removeRule(${i})" style="padding:2px 8px;">X</button>
                </div>
            </td>
        </tr>`;
    });
}

function formatIPRule(net) {
    if (!net || net.id === "any") return "any";
    if (net.ip === "0.0.0.0" && net.wildcard === "255.255.255.255") return "any";
    if (net.wildcard === "0.0.0.0") return `host ${net.ip}`;
    return `${net.ip} ${net.wildcard}`;
}

function generateOutput() {
    const output = document.getElementById('output-code');

    if (acls.length === 0) {
        output.innerHTML = "/* Aucune ACL à générer */";
        return;
    }

    let code = "";

    acls.forEach(acl => {
        code += `<span class="comment-text">! ==========================================</span>\n`;
        code += `<span class="comment-text">! Configuration de l'ACL: ${acl.name}</span>\n`;
        code += `<span class="comment-text">! ==========================================</span>\n`;
        code += `<span class="keyword-text">ip access-list extended ${acl.name}</span>\n`;

        if (acl.rules.length === 0) {
            code += ` <span class="comment-text">! (Aucune règle définie)</span>\n`;
        } else {
            acl.rules.forEach((r, i) => {
                if(r.comment) code += `<span class="comment-text"> ! ${r.comment}</span>\n`;

                const srcNet = networks.find(n => n.id === r.srcId);
                const dstNet = networks.find(n => n.id === r.dstId);

                const src = formatIPRule(srcNet);
                const dst = formatIPRule(dstNet);

                let portStr = "";
                if (r.proto === 'icmp' && r.portStart) {
                    portStr = ` ${r.portStart}`;
                } else if ((r.proto === 'tcp' || r.proto === 'udp') && r.portStart) {
                    if (r.operator === 'range' && r.portEnd) {
                        portStr = ` range ${r.portStart} ${r.portEnd}`;
                    } else {
                        portStr = ` ${r.operator} ${r.portStart}`;
                    }
                }

                code += ` <span class="keyword-text">${r.action}</span> ${r.proto} ${src} ${dst}${portStr}\n`;
            });
        }

        code += ` exit\n<span class="comment-text">!</span>\n`;

        if (acl.targets.length > 0) {
            acl.targets.forEach(t => {
                const prefix = isNaN(t.id) ? "" : "Vlan";
                code += `<span class="keyword-text">interface ${prefix}${t.id}</span>\n ip access-group ${acl.name} ${t.dir}\n<span class="comment-text">!</span>\n`;
            });
        } else {
            code += `<span class="comment-text">! Note: Aucun VLAN cible défini pour ${acl.name}</span>\n\n`;
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
    const btnCurrent = document.getElementById('tab-mermaid-current');
    const btnAll = document.getElementById('tab-mermaid-all');
    
    if (tab === 'current') {
        btnCurrent.className = 'dark';
        btnAll.className = 'outline';
    } else {
        btnCurrent.className = 'outline';
        btnAll.className = 'dark';
    }
    renderMermaidDiagram();
}

function toggleMermaidLayout() {
    const btn = document.getElementById('btn-mermaid-layout');
    if (currentMermaidLayout === 'LR') {
        currentMermaidLayout = 'TD';
        btn.innerText = "🔄 Orientation : Verticale";
    } else {
        currentMermaidLayout = 'LR';
        btn.innerText = "🔄 Orientation : Horizontale";
    }
    renderMermaidDiagram();
}

async function renderMermaidDiagram() {
    const container = document.getElementById('mermaid-output');
    let rulesToRender = [];
    
    if (activeMermaidTab === 'current') {
        const activeAcl = getActiveAcl();
        if (!activeAcl || activeAcl.rules.length === 0) {
            container.innerHTML = "<span class='empty-state'>Aucune règle à afficher pour cette ACL.</span>";
            lastMermaidSvgString = "";
            if (panZoomInstance) { panZoomInstance.destroy(); panZoomInstance = null; }
            return;
        }
        rulesToRender = activeAcl.rules.map(r => ({...r, aclName: ''}));
    } else {
        if (acls.length === 0) {
            container.innerHTML = "<span class='empty-state'>Aucune ACL configurée sur le projet.</span>";
            lastMermaidSvgString = "";
            if (panZoomInstance) { panZoomInstance.destroy(); panZoomInstance = null; }
            return;
        }
        acls.forEach(acl => {
            acl.rules.forEach(r => {
                rulesToRender.push({...r, aclName: acl.name});
            });
        });
        
        if (rulesToRender.length === 0) {
            container.innerHTML = "<span class='empty-state'>Aucune règle n'existe dans le projet global.</span>";
            lastMermaidSvgString = "";
            if (panZoomInstance) { panZoomInstance.destroy(); panZoomInstance = null; }
            return;
        }
    }

    let graph = `graph ${currentMermaidLayout}\n`;
    
    networks.forEach(n => {
        let idNode = n.id === "any" ? "any_node" : "vlan_" + n.id;
        let label = n.id === "any" ? "Internet (Any)" : `VLAN${n.id}<br/>${n.name}`;
        graph += `    ${idNode}["${label}"]\n`;
    });

    let linkIndex = 0;
    let linkStyles = "";

    rulesToRender.forEach(r => {
        let srcNode = r.srcId === "any" ? "any_node" : "vlan_" + r.srcId;
        let dstNode = r.dstId === "any" ? "any_node" : "vlan_" + r.dstId;
        
        let icon = r.action === 'permit' ? '✅' : '❌';
        let portInfo = (r.proto !== 'ip' && r.portStart) ? ` ${r.portStart}` : '';
        
        let aclPrefix = r.aclName ? `[${r.aclName}]<br/>` : '';
        let labelText = `${aclPrefix}${icon} ${r.proto.toUpperCase()}${portInfo}`;

        graph += `    ${srcNode} -- "${labelText}" --> ${dstNode}\n`;

        if (r.action === 'permit') {
            linkStyles += `    linkStyle ${linkIndex} stroke:green,stroke-width:2px,color:green;\n`;
        } else {
            linkStyles += `    linkStyle ${linkIndex} stroke:red,stroke-width:2px,color:red;\n`;
        }
        linkIndex++;
    });

    graph += linkStyles;

    try {
        mermaid.mermaidAPI.reset();
        const uniqueId = 'mermaid-graph-' + Date.now();
        const { svg } = await mermaid.render(uniqueId, graph);
        
        lastMermaidSvgString = svg;
        container.innerHTML = svg;

        const svgElement = container.querySelector('svg');
        if (svgElement) {
            svgElement.style.width = '100%';
            svgElement.style.height = '100%';
            svgElement.style.maxWidth = 'none';

            if (panZoomInstance) panZoomInstance.destroy();

            panZoomInstance = svgPanZoom(svgElement, {
                zoomEnabled: true,
                controlIconsEnabled: true,
                fit: true,
                center: true,
                minZoom: 0.1,
                maxZoom: 10
            });
        }

    } catch (error) {
        console.error("Erreur de rendu Mermaid", error);
        container.innerHTML = "<span style='color: red;'>Erreur lors de la création du diagramme. Regardez la console (F12).</span>";
    }
}

function downloadMermaidPng() {
    if (!lastMermaidSvgString) {
        alert("Aucun diagramme à exporter pour le moment.");
        return;
    }

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = lastMermaidSvgString;
    const svgElement = tempDiv.querySelector('svg');
    
    svgElement.style.backgroundColor = '#ffffff';

    let width = 1200; 
    let height = 800; 
    if (svgElement.viewBox && svgElement.viewBox.baseVal) {
        width = svgElement.viewBox.baseVal.width || width;
        height = svgElement.viewBox.baseVal.height || height;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const svgData = new XMLSerializer().serializeToString(svgElement);
    const img = new Image();
    
    img.onload = function() {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, width, height);
        
        const a = document.createElement('a');
        a.download = `Topologie_ACL_${activeMermaidTab}.png`;
        a.href = canvas.toDataURL('image/png');
        a.click();
    };
    
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
}

function toggleFullscreen() {
    const wrapper = document.getElementById('mermaid-output-wrapper');
    if (!document.fullscreenElement) {
        wrapper.requestFullscreen().catch(err => {
            alert(`Erreur lors du passage en plein écran : ${err.message}`);
        });
    } else {
        document.exitFullscreen();
    }
}

// ==========================================
// 10. EXPORT / IMPORT DE FICHIERS
// ==========================================
function exportConfigTxt() {
    const text = document.getElementById('output-code').innerText;
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `config_acl_complete.txt`;
    a.click();
}

function exportJson() {
    const data = JSON.stringify({ networks, acls, activeAclId }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `projet_multi_acl.json`;
    a.click();
}

function importJson(event) {
    const file = event.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const data = JSON.parse(e.target.result);
        networks = data.networks;

        if(data.rules && !data.acls) {
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
    };
    reader.readAsText(file);
}