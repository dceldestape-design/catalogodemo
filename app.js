/**
 * EcomDx Preventa - Main Application Engine
 */

// Global State
let state = {
  products: [],
  clients: [],
  discounts: [],
  cabysMap: {},
  images: {},
  maestros: { proveedores: {}, categorias: {} },
  vendedor: null,
  pendingVendor: null,
  selectedSupplier: 'ALL',
  sheetsUrl: "",
  currentClient: null,
  selectedCategory: 'ALL',
  searchQuery: '',
  deferredPrompt: null,
  zoomLevel: 1
};

// Format currency in Costa Rican Colones (₡)
const formatColones = (num) => {
  return '₡ ' + Math.round(num).toLocaleString('es-CR');
};

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  initPWA();
  await loadCatalogData();
  setupEventListeners();
});

/**
 * PWA Service Worker & Install Prompt
 */
function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('Service Worker registrado correctamente para modo offline.'))
      .catch((e) => console.log('Service Worker error:', e));
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredPrompt = e;
    const btn = document.getElementById('menu-install');
    if (btn) btn.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    console.log('EcomDx Preventa instalada como App nativa');
    const btn = document.getElementById('menu-install');
    if (btn) btn.classList.add('hidden');
  });
}

/**
 * Menú móvil (⋯): abre/cierra. Cierra con Escape o toque fuera.
 */
function toggleMenu(forceClose) {
  const menu = document.getElementById('app-menu');
  if (!menu) return;
  if (forceClose === true) {
    menu.classList.add('hidden');
    return;
  }
  menu.classList.toggle('hidden');
}

function installPWA() {
  if (state.deferredPrompt) {
    state.deferredPrompt.prompt();
    state.deferredPrompt.userChoice.then((choice) => {
      if (choice.outcome === 'accepted') {
        console.log('Usuario aceptó instalar la PWA');
      }
      state.deferredPrompt = null;
    });
  }
}

/**
 * Carga de datos del catálogo (Local Storage o Bundle)
 */
async function loadCatalogData() {
  try {
    // 1. Catálogo publicado más recientemente por el administrador
    const published = localStorage.getItem('ecomdx_published_catalog');
    if (published) {
      const data = JSON.parse(published);
      applyLoadedData(data);
      return;
    }

    // 2. Modo autónomo sin servidor (doble-clic directo a index.html o app offline)
    if (window.ECOMDX_CATALOG_DATA) {
      applyLoadedData(window.ECOMDX_CATALOG_DATA);
      return;
    }

    // 3. Fallback a fetch por si corre en hosting HTTP
    const res = await fetch('../shared-data/catalog_bundle.json');
    if (res.ok) {
      const data = await res.json();
      applyLoadedData(data);
      return;
    }
  } catch (err) {
    console.warn("Error cargando datos:", err);
  }
}

function applyLoadedData(data) {
  state.products = data.products || [];
  state.clients = data.clients || [];
  state.discounts = data.discounts || [];
  state.cabysMap = data.cabysMap || {};

  // URL del Sheet publicada por el Admin (viaja en el catálogo, no en código)
  if (data.config && data.config.sheetsUrl) {
    state.sheetsUrl = String(data.config.sheetsUrl).trim();
    try { localStorage.setItem('ecomdx_sheets_url', state.sheetsUrl); } catch (e) {}
  }
  // Maestros de proveedores/categorías (nombres del Sheet, códigos del ERP)
  if (data.config && data.config.maestros) {
    state.maestros = {
      proveedores: data.config.maestros.proveedores || {},
      categorias: data.config.maestros.categorias || {}
    };
  }  if (!state.sheetsUrl) {
    try { state.sheetsUrl = localStorage.getItem('ecomdx_sheets_url') || ''; } catch (e) {}
  }
  const manualUrl = (document.getElementById('login-sheets-url')?.value || "").trim();
  if (manualUrl) state.sheetsUrl = manualUrl;
  const wrap = document.getElementById('login-sheets-wrap');
  if (wrap) wrap.classList.toggle('hidden', !!state.sheetsUrl);
  
  // Mapeo de fotos: fusionar base del bundle con guardadas
  const baseImages = data.sampleImages || data.images || {};
  let saved = {};
  try {
    const savedImages = localStorage.getItem('ecomdx_images');
    if (savedImages) saved = JSON.parse(savedImages) || {};
  } catch (e) { saved = {}; }
  state.images = { ...baseImages, ...saved };
  if (Object.keys(state.images).length > Object.keys(saved).length) {
    try { localStorage.setItem('ecomdx_images', JSON.stringify(state.images)); } catch (e) {}
  }

  // Establecer cliente inicial
  selectInitialClient();
  renderCategoryChips();
  applyFilters();
  // Maestros directo del Sheet como respaldo (si el bundle aún no los trae)
  loadMaestros();
  // Puerta de acceso por vendedor (verificada en el Sheet)
  requireLogin();
}

/**
 * Lee Proveedores/Categorias directo del Sheet para no depender del publicado.
 */
async function loadMaestros() {
  if (!state.sheetsUrl) return;
  try {
    const res = await fetch(`${state.sheetsUrl}?action=get_maestros`);
    const json = await res.json();
    if (json.status === "success" && json.maestros) {
      const has = Object.keys(json.maestros.proveedores || {}).length + Object.keys(json.maestros.categorias || {}).length;
      if (has > 0) {
        state.maestros = {
          proveedores: json.maestros.proveedores || {},
          categorias: json.maestros.categorias || {}
        };
        renderCategoryChips();
        applyFilters();
      }
    }
  } catch (e) {
    console.warn("maestros:", e);
  }
}

/**
 * Acceso por código de vendedor. Permisos verificados en el servidor (Code.gs),
 * las contraseñas nunca se descargan al teléfono.
 */
function getStoredSession() {
  try {
    const raw = localStorage.getItem('ecomdx_vendedor_session');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function requireLogin() {
  const s = getStoredSession();
  if (s && s.codigo) {
    state.vendedor = s;
    showAppForSeller();
    // Traer la ruta del vendedor (su usuario=) en segundo plano
    refreshVendorCatalog(false);
  } else {
    state.vendedor = null;
    document.getElementById('login-overlay')?.classList.remove('hidden');
    // Primera vez sin URL: abrir Configuración para pegarla
    if (!state.sheetsUrl) openConfigModal();
  }
}

/**
 * Descarga el catálogo propio del vendedor vía Sheet (action=fetch&v=).
 * El Sheet usa el link api_<tipo>_<VENDEDOR> con su usuario=, o el genérico.
 */
async function fetchVendorType(type, vendor) {
  const res = await fetch(`${state.sheetsUrl}?action=fetch&type=${type}&v=${encodeURIComponent(vendor)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "success" || !Array.isArray(json.items)) {
    throw new Error((json && json.message) || "Respuesta inválida del Sheet");
  }
  return json.items;
}

async function downloadVendorCatalog(vendor) {
  const [products, clients, discounts, cabysItems] = await Promise.all([
    fetchVendorType("products", vendor),
    fetchVendorType("clients", vendor),
    fetchVendorType("discounts", vendor),
    fetchVendorType("cabys", vendor)
  ]);
  const cabysMap = {};
  cabysItems.forEach(c => { if (c && c.pro_codecom) cabysMap[String(c.pro_codecom).trim()] = c; });
  return { products, clients, discounts, cabysMap };
}

function getVendorCache(vendor) {
  try {
    const raw = localStorage.getItem('ecomdx_vendor_catalog');
    if (raw) {
      const j = JSON.parse(raw);
      if (j && String(j.vendor || "").toUpperCase() === String(vendor || "").toUpperCase() && j.catalog) return j.catalog;
    }
  } catch (e) {}
  return null;
}

function applyVendorCatalog(cat) {
  state.products = cat.products || [];
  state.clients = cat.clients || [];
  state.discounts = cat.discounts || [];
  state.cabysMap = cat.cabysMap || {};
  try {
    localStorage.setItem('ecomdx_vendor_catalog', JSON.stringify({
      vendor: state.vendedor.codigo,
      ts: new Date().toISOString(),
      catalog: cat
    }));
  } catch (e) {}
  state.selectedCategory = 'ALL';
  selectInitialClient();
  renderCategoryChips();
  applyFilters();
}

// Sesión restaurada: intenta ruta fresca, si no hay red usa la guardada, si no el bundle.
async function refreshVendorCatalog(strict) {
  if (!state.vendedor || !state.sheetsUrl) return false;
  try {
    applyVendorCatalog(await downloadVendorCatalog(state.vendedor.codigo));
    return true;
  } catch (e) {
    console.warn("ruta vendedor:", e);
    const cached = getVendorCache(state.vendedor.codigo);
    if (cached) {
      state.products = cached.products || [];
      state.clients = cached.clients || [];
      state.discounts = cached.discounts || [];
      state.cabysMap = cached.cabysMap || {};
      state.selectedCategory = 'ALL';
      selectInitialClient();
      renderCategoryChips();
      applyFilters();
      return true;
    }
    if (strict) throw e;
    return false;
  }
}

function showAppForSeller() {
  document.getElementById('login-overlay')?.classList.add('hidden');
  const pill = document.getElementById('header-seller-name');
  if (pill) pill.textContent = state.vendedor.codigo;
  const btn = document.getElementById('btn-seller');
  if (btn) btn.title = `${state.vendedor.nombre || ''} (${state.vendedor.codigo}) - Salir`;
  // Maestros con la URL ya disponible (login manual o config) para nombrar chips
  loadMaestros();
}

async function loginVendedor() {
  const login = (document.getElementById('login-code')?.value || "").trim();
  const password = (document.getElementById('login-password')?.value || "");
  const err = document.getElementById('login-error');
  const showErr = (m) => { if (err) { err.textContent = m; err.classList.remove('hidden'); } };
  if (err) err.classList.add('hidden');

  const manualUrl = (document.getElementById('login-sheets-url')?.value || "").trim();
  if (manualUrl) {
    state.sheetsUrl = manualUrl;
    try { localStorage.setItem('ecomdx_sheets_url', manualUrl); } catch (e) {}
  }
  if (!login || !password) { showErr("Ingresa tu código y contraseña."); return; }
  if (!state.sheetsUrl) {
    showErr("Falta la URL del sistema. Pégala en la ventana de Configuración.");
    openConfigModal();
    return;
  }
  if (!navigator.onLine) { showErr("Sin conexión: el primer ingreso requiere internet. Luego funciona offline."); return; }

  const btn = document.getElementById('btn-login');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(state.sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "login", login, password })
    });
    const json = await res.json();
    if (json.status !== "success" || !json.vendedor) {
      throw new Error((json && json.message) || "Acceso denegado.");
    }
    state.vendedor = {
      codigo: json.vendedor.codigo,
      nombre: json.vendedor.nombre,
      usuario: json.vendedor.usuario
    };
    const pw = document.getElementById('login-password');
    if (pw) pw.value = "";
    // Credenciales válidas: ahora el preventa decide si actualiza su ruta o usa caché
    state.pendingVendor = { ...state.vendedor };
    state.vendedor = null;
    showRouteChoice();
  } catch (e) {
    console.warn("login:", e);
    showErr(e.message || "No se pudo validar el acceso.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-right-to-bracket"></i><span>Ingresar</span>`;
    }
  }
}

/**
 * Paso 2 del ingreso: el preventa decide si actualiza su ruta o usa la caché.
 */
function showRouteChoice() {
  document.getElementById('login-step-1')?.classList.add('hidden');
  document.getElementById('login-step-2')?.classList.remove('hidden');
  const re = document.getElementById('login-route-error');
  if (re) re.classList.add('hidden');
  const name = document.getElementById('login-seller-name');
  if (name && state.pendingVendor) {
    name.textContent = `${state.pendingVendor.nombre || ''} (${state.pendingVendor.codigo})`.trim();
  }
  const info = document.getElementById('login-cache-info');
  if (info && state.pendingVendor) {
    let cacheTs = null;
    try {
      const raw = localStorage.getItem('ecomdx_vendor_catalog');
      if (raw) {
        const j = JSON.parse(raw);
        if (j && String(j.vendor || "").toUpperCase() === String(state.pendingVendor.codigo || "").toUpperCase()) cacheTs = j.ts;
      }
    } catch (e) {}
    info.textContent = cacheTs
      ? `Tienes datos guardados (${new Date(cacheTs).toLocaleString()}). Puedes usarlos sin descargar.`
      : `Aún no tienes datos guardados en este equipo: debes actualizar tu ruta.`;
  }
}

function saveVendorSession() {
  state.vendedor = { ...state.pendingVendor, ts: new Date().toISOString() };
  try { localStorage.setItem('ecomdx_vendedor_session', JSON.stringify(state.vendedor)); } catch (e) {}
  state.pendingVendor = null;
}

async function confirmDownloadRoute() {
  if (!state.pendingVendor) return;
  const btn = document.getElementById('btn-download-route');
  const original = `<i class="fa-solid fa-cloud-arrow-down"></i><span>Sí, actualizar mi ruta</span>`;
  if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>Descargando tu ruta...</span>`; }
  const re = document.getElementById('login-route-error');
  if (re) re.classList.add('hidden');
  try {
    state.vendedor = { ...state.pendingVendor };
    applyVendorCatalog(await downloadVendorCatalog(state.vendedor.codigo));
    saveVendorSession();
    resetLoginSteps();
    showAppForSeller();
  } catch (e) {
    console.warn("ruta:", e);
    state.vendedor = null;
    if (re) { re.textContent = `No se pudo actualizar: ${e.message}. Puedes usar tus datos guardados.`; re.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}

function useCachedRoute() {
  if (!state.pendingVendor) return;
  const cached = getVendorCache(state.pendingVendor.codigo);
  const re = document.getElementById('login-route-error');
  if (!cached) {
    if (re) { re.textContent = "No hay datos guardados de tu ruta en este equipo. Elige actualizar."; re.classList.remove('hidden'); }
    return;
  }
  state.vendedor = { ...state.pendingVendor };
  state.products = cached.products || [];
  state.clients = cached.clients || [];
  state.discounts = cached.discounts || [];
  state.cabysMap = cached.cabysMap || {};
  state.selectedCategory = 'ALL';
  saveVendorSession();
  resetLoginSteps();
  showAppForSeller();
  selectInitialClient();
  renderCategoryChips();
  applyFilters();
}

function resetLoginSteps() {
  document.getElementById('login-step-2')?.classList.add('hidden');
  document.getElementById('login-step-1')?.classList.remove('hidden');
}

function logoutVendedor() {
  if (!confirm("¿Cerrar sesión de vendedor?")) return;
  try { localStorage.removeItem('ecomdx_vendedor_session'); } catch (e) {}
  state.vendedor = null;
  state.pendingVendor = null;
  resetLoginSteps();
  document.getElementById('login-overlay')?.classList.remove('hidden');
}

/**
 * Selecciona cliente inicial (por URL param o primer cliente)
 */
function selectInitialClient() {
  const urlParams = new URLSearchParams(window.location.search);
  const clientCode = urlParams.get('clientCode') || localStorage.getItem('ecomdx_selected_client_code');

  if (clientCode) {
    const found = state.clients.find(c => String(c.cli_codigo).trim() === String(clientCode).trim());
    if (found) {
      setClient(found);
      return;
    }
  }

  // Por defecto el primer cliente (ej: SUPER OSO)
  if (state.clients.length > 0) {
    setClient(state.clients[0]);
  }
}

function setClient(client) {
  state.currentClient = client;
  localStorage.setItem('ecomdx_selected_client_code', client.cli_codigo);

  // Actualizar Header
  document.getElementById('header-client-code').textContent = `${client.cli_codigo}`;
  document.getElementById('header-client-name').textContent = client.cli_nombre;
  
  const listNum = String(client.cli_lista || '1').trim();
  const listBadge = document.getElementById('header-client-list-badge');
  listBadge.textContent = `L${listNum}`;

  // Actualizar Chips de Categoría y Productos
  state.selectedCategory = 'ALL';
  state.selectedSupplier = 'ALL';
  renderCategoryChips();
  applyFilters();
}

/**
 * Reglas de Negocio Centrales:
 * 1. Ocultar productos sin stock (pro_invent <= 0).
 * 2. Ocultar productos que no tengan la lista asignada del cliente (cli_lista).
 * 3. Calcular la suma de descuentos (cli_descue + des_descto comercial).
 * 4. Obtener IVA oficial de CABYS.
 */
function getClientVisibleProducts() {
  if (!state.currentClient) return [];

  const clientList = String(state.currentClient.cli_lista || '1').trim();
  const clientBaseDiscount = parseFloat(state.currentClient.cli_descue || 0);

  return state.products
    .filter(p => {
      // Regla 1: Stock > 0
      const stock = parseFloat(p.pro_invent || 0);
      if (stock <= 0) return false;

      // Regla 2: Producto debe tener precio en la lista asignada del cliente
      const listas = p.pro_listas || [];
      const hasListPrice = listas.some(l => 
        String(l.det_lista).trim() === clientList && parseFloat(l.det_valor || 0) > 0
      );

      return hasListPrice;
    })
    .map(p => {
      // Extraer precio de la lista del cliente
      const listaObj = p.pro_listas.find(l => String(l.det_lista).trim() === clientList);
      const basePrice = parseFloat(listaObj.det_valor || 0);

      // Regla 3: Descuento comercial aplicable
      const commercialDiscount = getCommercialDiscount(p, state.currentClient);
      const totalDiscountPercent = clientBaseDiscount + commercialDiscount;

      // Precios calculados
      // Fórmula sin descuento: valor + %IVA
      // Fórmula con descuento: (valor - %descuento) + %IVA
      // Todos los precios mostrados integran ya el IVA (IVAI)
      const discountAmount = basePrice * (totalDiscountPercent / 100);
      const netPrice = Math.max(0, basePrice - discountAmount);

      // Regla 4: IVA desde CABYS
      const cabysEntry = state.cabysMap[String(p.pro_codigo).trim()];
      const ivaPercent = cabysEntry && cabysEntry.pro_poriva !== undefined 
        ? parseFloat(cabysEntry.pro_poriva) 
        : parseFloat(p.pro_iva || 13);

      const basePriceWithIva = basePrice * (1 + ivaPercent / 100);
      const netPriceWithIva = netPrice * (1 + ivaPercent / 100);

      return {
        ...p,
        calc: {
          clientList,
          basePrice,
          basePriceWithIva,
          clientBaseDiscount,
          commercialDiscount,
          totalDiscountPercent,
          netPrice,
          netPriceWithIva,
          ivaPercent,
          cabysCode: cabysEntry ? cabysEntry.pro_cabys : (p.pro_cabys || 'Pendiente')
        }
      };
    });
}

/**
 * Jerarquías del ERP (vienen como arreglo de 1 objeto) + nombres de maestros.
 */
function prodJer(p) {
  const j = p && p.pro_jerarquias;
  if (Array.isArray(j)) return j[0] || {};
  return j || {};
}
function provCode(p) { return String(prodJer(p).det_provee || "").trim(); }
function catCode(p) { return String(prodJer(p).det_catego || "").trim(); }
function provName(code) { return (state.maestros.proveedores || {})[String(code || "").trim()] || ""; }
function catName(code) { return (state.maestros.categorias || {})[String(code || "").trim()] || ""; }

/**
 * Busca descuento comercial para el producto y cliente.
 * Cruza jerarquías (det_provee, det_marca, det_catego, det_familia...) con
 * las reglas (des_provee, des_marca, des_catego...).
 */
function getCommercialDiscount(product, client) {
  if (!state.discounts || state.discounts.length === 0) return 0;

  const clientCode = String(client.cli_codigo).trim();
  const jer = prodJer(product);
  const jval = (k) => String(jer[k] || '').trim();

  // [campo regla, valor producto]
  const H = [
    ['des_produc', String(product.pro_codigo).trim()],
    ['des_provee', jval('det_provee')],
    ['des_linea', jval('det_linea')],
    ['des_sublin', jval('det_sublin')],
    ['des_marca', jval('det_marca')],
    ['des_submar', jval('det_submar')],
    ['des_negoci', jval('det_negoci')],
    ['des_catego', jval('det_catego')],
    ['des_subcat', jval('det_subcat')],
    ['des_grupo', jval('det_grupo')],
    ['des_famili', jval('det_familia') || jval('det_famili')]
  ];

  let maxDiscount = 0;

  for (const d of state.discounts) {
    if (d.des_estado && d.des_estado !== 'A') continue;

    // Verificar si aplica al cliente o es general
    const matchClient = !d.des_client || String(d.des_client).trim() === clientCode;
    if (!matchClient) continue;

    // Jerarquías especificadas en la regla
    const scoped = H.filter(([k]) => String(d[k] || '').trim() !== '');
    // Sin jerarquía = regla general del cliente
    const matchScope = scoped.length === 0 || scoped.some(([k, pv]) => {
      const dv = String(d[k] || '').trim();
      return pv !== '' && dv === pv;
    });
    if (!matchScope) continue;

    const discountVal = parseFloat(d.des_descto || 0);
    if (discountVal > maxDiscount) {
      maxDiscount = discountVal;
    }
  }

  return maxDiscount;
}

/**
 * Aplica filtros de búsqueda y categoría
 */
function applyFilters() {
  const allVisible = getClientVisibleProducts();
  const search = (document.getElementById('catalog-search-input')?.value || '').toLowerCase().trim();
  state.searchQuery = search;

  const clearBtn = document.getElementById('btn-clear-search');
  if (clearBtn) {
    if (search) clearBtn.classList.remove('hidden');
    else clearBtn.classList.add('hidden');
  }

  const filtered = allVisible.filter(p => {
    // Filtro por proveedor
    if (state.selectedSupplier !== 'ALL') {
      if (provCode(p) !== state.selectedSupplier) return false;
    }

    // Filtro por categoría
    if (state.selectedCategory !== 'ALL') {
      if (catCode(p) !== state.selectedCategory) return false;
    }

    // Filtro por búsqueda
    if (search) {
      const nameMatch = String(p.pro_nombre || '').toLowerCase().includes(search);
      const codeMatch = String(p.pro_codigo || '').toLowerCase().includes(search);
      const barcodeMatch = p.pro_jerarquias && String(p.pro_jerarquias.det_codbar || '').toLowerCase().includes(search);
      return nameMatch || codeMatch || barcodeMatch;
    }

    return true;
  });

  renderProductsGrid(filtered, allVisible.length);
}

/**
 * Renderiza los Chips de Proveedor y Categoría (con nombres de maestros)
 */
function renderCategoryChips() {
  const supContainer = document.getElementById('supplier-chips-container');
  const container = document.getElementById('category-chips-container');
  if (!container) return;

  const visible = getClientVisibleProducts();
  const suppliersSet = new Set();
  const categoriesSet = new Set();

  visible.forEach(p => {
    const s = provCode(p), c = catCode(p);
    if (s) suppliersSet.add(s);
    if (c) categoriesSet.add(c);
  });

  const suppliers = Array.from(suppliersSet).sort();
  const categories = Array.from(categoriesSet).sort();

  if (supContainer) {
    let shtml = `
      <button onclick="selectSupplier('ALL')" class="category-chip ${state.selectedSupplier === 'ALL' ? 'active bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200'} px-3 py-1 rounded-full text-[11px] font-semibold shrink-0 transition">
        Prov: Todos
      </button>
    `;
    suppliers.forEach(sup => {
      const isAct = state.selectedSupplier === sup;
      const nm = provName(sup);
      shtml += `
        <button onclick="selectSupplier('${sup}')" class="category-chip ${isAct ? 'active bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200'} px-3 py-1 rounded-full text-[11px] font-medium shrink-0 transition">
          ${nm ? nm : 'Prov ' + sup}
        </button>
      `;
    });
    supContainer.innerHTML = shtml;
  }

  let html = `
    <button onclick="selectCategory('ALL')" class="category-chip ${state.selectedCategory === 'ALL' ? 'active bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200'} px-3 py-1 rounded-full text-[11px] font-semibold shrink-0 transition">
      Todos (${visible.length})
    </button>
  `;

  categories.forEach(cat => {
    const isAct = state.selectedCategory === cat;
    const nm = catName(cat);
    html += `
      <button onclick="selectCategory('${cat}')" class="category-chip ${isAct ? 'active bg-blue-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200'} px-3 py-1 rounded-full text-[11px] font-medium shrink-0 transition">
        ${nm ? nm : 'Categoría ' + cat}
      </button>
    `;
  });

  container.innerHTML = html;
}

function selectSupplier(sup) {
  state.selectedSupplier = sup;
  renderCategoryChips();
  applyFilters();
}

function selectCategory(cat) {
  state.selectedCategory = cat;
  renderCategoryChips();
  applyFilters();
}

/**
 * Renderiza la cuadrícula de productos
 */
function renderProductsGrid(products, totalClientProducts) {
  const grid = document.getElementById('products-grid');
  const emptyState = document.getElementById('catalog-empty-state');
  const counter = document.getElementById('catalog-counter');

  if (counter) {
    counter.textContent = `${products.length} de ${totalClientProducts} productos disponibles`;
  }

  if (products.length === 0) {
    grid.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  grid.innerHTML = products.map(p => {
    const photos = state.images[p.pro_codigo] || [];
    const photoUrl = photos.length > 0 ? photos[0] : '';

    const calc = p.calc;
    const hasDiscount = calc.totalDiscountPercent > 0;

    const imgElement = photoUrl 
      ? `<img src="${photoUrl}" alt="${p.pro_nombre}" loading="lazy" onerror="this.onerror=null;this.src='../images/logo.png'" class="w-full h-full object-contain p-2 group-hover:scale-105 transition duration-300">`
      : `<div class="w-full h-full flex flex-col items-center justify-center text-slate-300 gap-1 bg-slate-50">
           <i class="fa-solid fa-box text-3xl"></i>
           <span class="text-[9px] text-slate-400 font-medium">Foto HD Pendiente</span>
         </div>`;

    return `
      <div class="product-card bg-white rounded-2xl border border-slate-200/80 hover:border-blue-400/80 shadow-xs hover:shadow-md transition-all flex flex-col overflow-hidden group">
        
        <!-- Image Container (Click opens HD Zoom) -->
        <div onclick="openZoomModal('${p.pro_codigo}')" class="relative w-full aspect-square bg-white border-b border-slate-100 flex items-center justify-center cursor-pointer overflow-hidden">
          ${imgElement}
          
          <!-- Discount Pill if applicable -->
          ${hasDiscount ? `
            <div class="absolute top-2 left-2 badge-discount text-white text-[10px] font-extrabold px-1.5 py-0.5 rounded-md shadow-xs flex items-center gap-1">
              <i class="fa-solid fa-arrow-down text-[8px]"></i>
              <span>-${calc.totalDiscountPercent}%</span>
            </div>
          ` : ''}

          <!-- Zoom Hint Icon on Hover -->
          <div class="absolute top-2 right-2 w-7 h-7 rounded-full bg-slate-900/60 backdrop-blur-xs text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition">
            <i class="fa-solid fa-magnifying-glass-plus"></i>
          </div>
        </div>

        <!-- Product Card Body -->
        <div class="p-3 flex-1 flex flex-col justify-between">
          <div>
            <!-- Code & Category -->
            <div class="flex items-center justify-between gap-1 text-[10px] text-slate-400 font-mono mb-1">
              <span class="font-bold text-blue-700 bg-blue-50 px-1 rounded">#${p.pro_codigo}</span>
              <span class="truncate">CABYS ${calc.cabysCode}</span>
            </div>

            <!-- Product Title -->
            <h4 class="text-xs font-bold text-slate-800 line-clamp-2 leading-snug group-hover:text-blue-600 transition" title="${p.pro_nombre}">
              ${p.pro_nombre}
            </h4>
            ${(() => { const pn = provName(provCode(p)), cn = catName(catCode(p)); return (pn || cn) ? `<div class="text-[10px] text-slate-400 truncate mt-0.5">${[pn, cn].filter(Boolean).join(' • ')}</div>` : ''; })()}
          </div>

          <!-- Pricing Block (Sin descuento: valor + IVA | Con descuento: valor - %dto + IVA, todo IVAI) -->
          <div class="mt-3 pt-2 border-t border-slate-100">
            ${hasDiscount ? `
              <div class="flex items-center justify-between text-[10px] text-slate-400">
                <span class="line-through">${formatColones(calc.basePriceWithIva)}</span>
                <span class="text-red-500 font-semibold">${calc.clientBaseDiscount}% + ${calc.commercialDiscount}%</span>
              </div>
            ` : ''}

            <div class="flex items-baseline justify-between mt-0.5">
              <div class="text-sm sm:text-base font-extrabold text-emerald-600">
                ${formatColones(calc.netPriceWithIva)}
              </div>
              <span class="text-[9px] font-semibold text-slate-400 uppercase">IVAI (${calc.ivaPercent}%)</span>
            </div>
          </div>

        </div>

      </div>
    `;
  }).join('');
}

/**
 * Modal de Zoom en Alta Definición
 */
function openZoomModal(productCode) {
  const visible = getClientVisibleProducts();
  const product = visible.find(p => String(p.pro_codigo).trim() === String(productCode).trim());
  if (!product) return;

  const photos = state.images[product.pro_codigo] || [];
  const photoUrl = photos.length > 0
    ? photos[0]
    : '../images/logo.png';

  const modal = document.getElementById('zoom-modal');
  const img = document.getElementById('modal-image');
  
  img.onerror = () => { img.onerror = null; img.src = '../images/logo.png'; };
  img.src = photoUrl;
  resetZoom();

  document.getElementById('zoom-product-code').textContent = `#${product.pro_codigo}`;
  document.getElementById('zoom-product-title').textContent = product.pro_nombre;
  document.getElementById('zoom-cabys-badge').textContent = product.calc.cabysCode;
  document.getElementById('zoom-iva-badge').textContent = `${product.calc.ivaPercent}%`;
  document.getElementById('zoom-price-badge').textContent = `${formatColones(product.calc.netPriceWithIva)} IVAI`;

  modal.classList.remove('hidden');
}

function closeZoomModal() {
  document.getElementById('zoom-modal').classList.add('hidden');
}

function zoomIn() {
  state.zoomLevel = Math.min(state.zoomLevel + 0.3, 3.5);
  updateZoom();
}

function zoomOut() {
  state.zoomLevel = Math.max(state.zoomLevel - 0.3, 0.8);
  updateZoom();
}

function resetZoom() {
  state.zoomLevel = 1;
  updateZoom();
}

function updateZoom() {
  const img = document.getElementById('modal-image');
  if (img) img.style.transform = `scale(${state.zoomLevel})`;
}

/**
 * Modal de Selección de Cliente
 */
function openClientModal() {
  document.getElementById('client-modal').classList.remove('hidden');
  renderClientModalList();
}

function closeClientModal() {
  document.getElementById('client-modal').classList.add('hidden');
}

function renderClientModalList() {
  const container = document.getElementById('modal-clients-list');
  if (!container) return;

  const search = (document.getElementById('modal-client-search')?.value || '').toLowerCase().trim();

  // Deduplicar por código (el ERP puede traer el mismo cliente repetido)
  const seen = new Set();
  const unique = [];
  for (const c of state.clients) {
    const code = String(c.cli_codigo || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    unique.push(c);
  }

  const filtered = unique.filter(c => {
    if (!search) return true;
    const nameMatch = String(c.cli_nombre || '').toLowerCase().includes(search);
    const codeMatch = String(c.cli_codigo || '').toLowerCase().includes(search);
    const docMatch = String(c.documento || '').toLowerCase().includes(search);
    return nameMatch || codeMatch || docMatch;
  });

  container.innerHTML = filtered.slice(0, 40).map(c => {
    const isCurrent = state.currentClient && state.currentClient.cli_codigo === c.cli_codigo;
    const listNum = String(c.cli_lista || '1').trim();
    const discount = parseFloat(c.cli_descue || 0);

    return `
      <div onclick="selectClientFromModal('${c.cli_codigo}')" class="p-3 hover:bg-blue-50/60 rounded-xl cursor-pointer transition flex items-center justify-between ${isCurrent ? 'bg-blue-50 border border-blue-200' : ''}">
        <div>
          <div class="flex items-center gap-2">
            <span class="text-xs font-extrabold text-slate-900">${c.cli_nombre}</span>
            ${isCurrent ? '<span class="text-[9px] font-bold bg-blue-600 text-white px-1.5 py-0.2 rounded-full">Activo</span>' : ''}
          </div>
          <div class="text-[10px] text-slate-400 flex items-center gap-2 mt-0.5">
            <span>Código: ${c.cli_codigo}</span>
            <span>•</span>
            <span>Cédula: ${c.documento || '-'}</span>
          </div>
        </div>
        <div class="text-right">
          <span class="text-xs font-bold text-blue-700 bg-blue-100/70 px-2 py-0.5 rounded-lg">Lista ${listNum}</span>
          ${discount > 0 ? `<div class="text-[10px] text-red-600 font-semibold mt-0.5">Dto: ${discount}%</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function selectClientFromModal(clientCode) {
  const client = state.clients.find(c => c.cli_codigo === clientCode);
  if (client) {
    setClient(client);
    closeClientModal();
  }
}

/**
 * Configuración: dirección del Sheet en este equipo (no se borra con la caché).
 */
function openConfigModal() {
  const input = document.getElementById('config-sheets-url');
  if (input) input.value = state.sheetsUrl || "";
  const info = document.getElementById('config-seller-info');
  if (info) info.textContent = state.vendedor ? `${state.vendedor.nombre || ''} (${state.vendedor.codigo})` : "Sin sesión";
  const route = document.getElementById('config-route-info');
  if (route) {
    try {
      const raw = localStorage.getItem('ecomdx_vendor_catalog');
      if (raw) {
        const j = JSON.parse(raw);
        const n = (j.catalog && j.catalog.products || []).length;
        route.textContent = `${j.vendor || '?'} • ${new Date(j.ts).toLocaleString()} • ${n} prod.`;
      } else {
        route.textContent = "Sin ruta guardada (viene del paquete base)";
      }
    } catch (e) {
      route.textContent = "—";
    }
  }
  const st = document.getElementById('config-status');
  if (st) st.classList.add('hidden');
  document.getElementById('config-modal')?.classList.remove('hidden');
}

function closeConfigModal() {
  document.getElementById('config-modal')?.classList.add('hidden');
}

function configMsg(text, ok) {
  const st = document.getElementById('config-status');
  if (!st) return;
  st.textContent = text;
  st.className = ok
    ? "text-xs font-medium text-emerald-600"
    : "text-xs font-medium text-rose-600";
}

function saveSheetsUrl() {
  const url = (document.getElementById('config-sheets-url')?.value || "").trim();
  if (!url) { configMsg("Pega la URL del sistema.", false); return; }
  state.sheetsUrl = url;
  try { localStorage.setItem('ecomdx_sheets_url', url); } catch (e) {}
  const loginInput = document.getElementById('login-sheets-url');
  if (loginInput) loginInput.value = url;
  const wrap = document.getElementById('login-sheets-wrap');
  if (wrap) wrap.classList.add('hidden');
  configMsg("Dirección guardada en este equipo.", true);
  loadMaestros();
}

async function testSheetsConnection() {
  const url = (document.getElementById('config-sheets-url')?.value || "").trim() || state.sheetsUrl;
  if (!url) { configMsg("Pega la URL primero.", false); return; }
  configMsg("Probando conexión...", true);
  try {
    const res = await fetch(`${url}?action=get_maestros`);
    const json = await res.json();
    if (json.status === "success") {
      configMsg("Conexión correcta con el Sheet.", true);
    } else {
      throw new Error(json.message || "Respuesta inválida");
    }
  } catch (e) {
    configMsg(`Sin conexión: ${e.message}`, false);
  }
}

/**
 * Recarga de datos
 */
async function reloadCatalogData() {
  await loadCatalogData();
  applyFilters();
}

/**
 * Borra TODA la caché vieja del navegador y recarga desde cero (bundle/Sheet).
 */
function clearPreventaCache() {
  ["ecomdx_published_catalog", "ecomdx_images", "ecomdx_selected_client_code", "ecomdx_vendedor_session", "ecomdx_vendor_catalog"].forEach(k => {
    try { localStorage.removeItem(k); } catch (e) {}
  });
  state.products = [];
  state.clients = [];
  state.discounts = [];
  state.cabysMap = {};
  state.images = {};
  state.currentClient = null;
  location.reload();
}

function clearSearch() {
  const input = document.getElementById('catalog-search-input');
  if (input) input.value = '';
  applyFilters();
}

function setupEventListeners() {
  // Tecla Escape cierra modales
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeZoomModal();
      closeClientModal();
      closeConfigModal();
      toggleMenu(true);
    }
    // Enter en login ingresa
    if (e.key === 'Enter' && !document.getElementById('login-overlay')?.classList.contains('hidden')) {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag !== "TEXTAREA") loginVendedor();
    }
  });
  // Segundo plano: al volver a la app, refrescar la ruta en silencio
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) backgroundRefreshVendor();
  });
  window.addEventListener('online', () => backgroundRefreshVendor());
  // Cerrar menú al tocar fuera
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('app-menu');
    if (menu && !menu.classList.contains('hidden')) {
      if (!e.target.closest('#app-menu') && !e.target.closest('#btn-seller')) {
        menu.classList.add('hidden');
      }
    }
  });
}

/**
 * Refresco en segundo plano con la sesión guardada (sin pedir login).
 * Solo actualiza si cambian cantidades o existencias, para no interrumpir.
 */
function stockSignature(products) {
  let sum = 0;
  for (const p of (products || [])) {
    const v = parseFloat(p.pro_invent || 0);
    if (!isNaN(v)) sum += v;
  }
  return `${(products || []).length}|${Math.round(sum)}`;
}

async function backgroundRefreshVendor() {
  if (!state.vendedor || !state.sheetsUrl || !navigator.onLine || state._bgRefreshing) return;
  if (!document.getElementById('login-overlay')?.classList.contains('hidden')) return;
  if (!document.getElementById('client-modal')?.classList.contains('hidden')) return;
  if (!document.getElementById('zoom-modal')?.classList.contains('hidden')) return;
  let last = 0;
  try { last = parseInt(localStorage.getItem('ecomdx_vendor_refresh_ts') || '0', 10) || 0; } catch (e) {}
  if (Date.now() - last < 15 * 60 * 1000) return;
  state._bgRefreshing = true;
  try {
    const cat = await downloadVendorCatalog(state.vendedor.codigo);
    try { localStorage.setItem('ecomdx_vendor_refresh_ts', String(Date.now())); } catch (e) {}
    if (stockSignature(cat.products) !== stockSignature(state.products)
      || cat.clients.length !== state.clients.length) {
      state.products = cat.products || [];
      state.clients = cat.clients || [];
      state.discounts = cat.discounts || [];
      state.cabysMap = cat.cabysMap || {};
      try {
        localStorage.setItem('ecomdx_vendor_catalog', JSON.stringify({
          vendor: state.vendedor.codigo,
          ts: new Date().toISOString(),
          catalog: cat
        }));
      } catch (e) {}
      // Conservar el cliente actual si sigue en la ruta
      const keep = state.currentClient && cat.clients.some(c => String(c.cli_codigo).trim() === String(state.currentClient.cli_codigo).trim());
      if (!keep) state.selectedCategory = 'ALL';
      if (keep) {
        const fresh = cat.clients.find(c => String(c.cli_codigo).trim() === String(state.currentClient.cli_codigo).trim());
        if (fresh) setClient(fresh);
      } else {
        selectInitialClient();
      }
      renderCategoryChips();
      applyFilters();
    }
  } catch (e) {
    console.warn("bg refresh:", e);
  } finally {
    state._bgRefreshing = false;
  }
}
