import express from "express";
import cors from "cors";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "mcp-version"]
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configuración de Google Sheets
let doc;
try {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
} catch (e) {
  console.error("Error al cargar credenciales de Google Sheets:", e);
}

// CACHÉ EN MEMORIA
// Aumentado a 15 minutos para evitar recargas constantes con 40k+ filas
let cachedRows = null;
let lastFetchTime = 0;
const CACHE_DURATION = 15 * 60 * 1000; 

async function obtenerFilasActualizadas() {
  const ahora = Date.now();
  if (!cachedRows || (ahora - lastFetchTime) > CACHE_DURATION) {
    if (!doc) return [];
    console.log("[CACHÉ] Cargando/actualizando filas desde Google Sheets...");
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    cachedRows = await sheet.getRows();
    lastFetchTime = ahora;
    console.log(`[CACHÉ ACTUALIZADA] Se cargaron ${cachedRows.length} filas desde Google Sheets.`);
  }
  return cachedRows;
}

// Estructura de herramientas MCP
const TOOLS_DEFINITION = [
  {
    name: "consultar_producto",
    description: "Busca productos en la planilla de la farmacia por descripción, marca, o SKU.",
    inputSchema: {
      type: "object",
      properties: {
        busqueda: { type: "string", description: "Palabras clave del producto (ej: 'crema cerave', 'ibupirac 600', '38801')" }
      },
      required: ["busqueda"]
    }
  }
];

// DICCIONARIO DE ABREVIATURAS Y SINÓNIMOS
const DICCIONARIO = {
  "crema": "cr",
  "cremas": "cr",
  "hidratante": "hidra",
  "hidratantes": "hidra",
  "humectante": "hidra",
  "comprimidos": "comp",
  "comprimido": "comp",
  "pastillas": "comp",
  "pastilla": "comp",
  "locion": "loc",
  "limpiador": "limp",
  "gel": "gel",
  "solucion": "sol",
  "jarabe": "jbe",
  "capsulas": "cap"
};

// Función para normalizar texto
function normalizar(texto) {
  return (texto || '')
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Quita tildes
    .replace(/[^a-z0-9\s]/g, " ");   // Símbolos a espacios
}

// Búsqueda Inteligente Avanzada
async function buscarProducto(query) {
  const rows = await obtenerFilasActualizadas();
  if (!rows || rows.length === 0) return [];

  const qNormalizado = normalizar(query);
  let palabrasOriginales = qNormalizado.split(/\s+/).filter(p => p.length > 0);

  if (palabrasOriginales.length === 0) return [];

  // Expandir palabras clave con el Diccionario
  const palabrasBusqueda = new Set();
  for (const p of palabrasOriginales) {
    palabrasBusqueda.add(p);
    if (DICCIONARIO[p]) {
      palabrasBusqueda.add(DICCIONARIO[p]); // Agrega 'cr' si la palabra era 'crema'
    }
  }

  const resultadosConPuntaje = [];

  for (const row of rows) {
    const descrip = normalizar(row.get('descrip'));
    const sku = normalizar(row.get('sku'));
    const barras = normalizar(row.get('barras'));
    const stock = parseInt(row.get('stock') || '0', 10);

    // 1. Coincidencia directa por SKU o Código de Barras
    if ((sku && sku.includes(qNormalizado)) || (barras && barras.includes(qNormalizado))) {
      resultadosConPuntaje.push({ row, score: 2000, stock });
      continue;
    }

    // 2. Sistema de puntuación
    let score = 0;
    for (const palabra of palabrasBusqueda) {
      if (descrip.includes(palabra)) {
        score += 15;
      } else if (palabra.length > 3 && descrip.includes(palabra.substring(0, 4))) {
        score += 5;
      }
    }

    // Si tiene stock disponible, sumamos un bono de prioridad
    if (score > 0 && stock > 0) {
      score += 50;
    }

    if (score > 0) {
      resultadosConPuntaje.push({ row, score, stock });
    }
  }

  // Ordenar por mayor puntaje y recortar a las 5 mejores coincidencias para mayor velocidad
  return resultadosConPuntaje
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ row }) => ({
      sku: row.get('sku'),
      barras: row.get('barras'),
      descripcion: row.get('descrip'),
      precio: row.get('precio'),
      stock: row.get('stock')
    }));
}

// Handler universal MCP
const handleRequest = async (req, res) => {
  console.log(`[PETICIÓN RECIBIDA] ${req.method} en ${req.url}`);
  if (req.body) {
    console.log(`[BODY RECIBIDO]`, JSON.stringify(req.body));
  }

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const body = req.body || {};
  const method = body.method;
  const id = body.id !== undefined ? body.id : 1;

  // Endpoint para listar herramientas
  if (method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS_DEFINITION
      }
    });
  }

  // Endpoint para ejecutar llamadas a herramientas
  if (method === "tools/call") {
    try {
      const busqueda = body.params?.arguments?.busqueda || "";
      const resultados = await buscarProducto(busqueda);
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(resultados) }]
        }
      });
    } catch (err) {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err.message }
      });
    }
  }

  // Respuesta general (inicialización o ping)
  return res.json({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      tools: TOOLS_DEFINITION,
      serverInfo: { name: "mcp-sheets-farmacia", version: "1.1.0" }
    }
  });
};

app.use("*", handleRequest);

// Inicialización de servidor + Warm-up
app.listen(PORT, async () => {
  console.log(`Servidor MCP listo en puerto ${PORT}`);
  try {
    console.log("[INICIALIZACIÓN] Precargando Google Sheets para evitar timeouts en la primera llamada...");
    await obtenerFilasActualizadas();
  } catch (err) {
    console.error("[ERROR EN PRECARGA INITIAL]", err);
  }
});
