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

// Estructura de herramientas para el protocolo MCP
const TOOLS_DEFINITION = [
  {
    name: "consultar_producto",
    description: "Busca productos en la planilla. Pásale palabras clave principales, marca o SKU.",
    inputSchema: {
      type: "object",
      properties: {
        busqueda: { type: "string", description: "Palabras clave del producto (ej: 'hipoglos', 'ibupirac', '38801')" }
      },
      required: ["busqueda"]
    }
  }
];

// Función para normalizar texto (quita tildes y convierte caracteres especiales en espacios)
function normalizar(texto) {
  return (texto || '')
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Quita tildes
    .replace(/[^a-z0-9\s]/g, " ");   // Reemplaza símbolos por espacios
}

// Búsqueda inteligente por sistema de puntaje (Relevancia)
async function buscarProducto(query) {
  if (!doc) return [];
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  
  const qNormalizado = normalizar(query);
  // Permitimos letras sueltas como la "X" o números
  const palabrasBusqueda = qNormalizado.split(/\s+/).filter(p => p.length > 0);
  
  if (palabrasBusqueda.length === 0) return [];

  const resultadosConPuntaje = [];

  for (const row of rows) {
    const descrip = normalizar(row.get('descrip'));
    const sku = normalizar(row.get('sku'));
    const barras = normalizar(row.get('barras'));

    // 1. Coincidencia directa por SKU o Código de Barras (Prioridad Alta)
    if ((sku && sku.includes(qNormalizado)) || (barras && barras.includes(qNormalizado))) {
      resultadosConPuntaje.push({ row, score: 1000 });
      continue;
    }

    // 2. Cálculo de coincidencia por palabras clave
    let score = 0;
    for (const palabra of palabrasBusqueda) {
      if (descrip.includes(palabra)) {
        score += 10; // Suma puntos si encuentra la palabra exacta
      } else if (palabra.length > 3 && descrip.includes(palabra.substring(0, 4))) {
        score += 5;  // Suma puntos si coincide el inicio (ej: "hidra" en "hidratante")
      }
    }

    if (score > 0) {
      resultadosConPuntaje.push({ row, score });
    }
  }

  // Ordena por mayor relevancia y devuelve los 10 mejores
  return resultadosConPuntaje
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ row }) => ({
      sku: row.get('sku'),
      barras: row.get('barras'),
      descripcion: row.get('descrip'),
      precio: row.get('precio'),
      stock: row.get('stock')
    }));
}

// Handler universal que responde a SSE y HTTP
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

  return res.json({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      tools: TOOLS_DEFINITION,
      serverInfo: { name: "mcp-sheets-farmacia", version: "1.0.0" }
    }
  });
};

app.use("*", handleRequest);

app.listen(PORT, () => console.log(`Servidor MCP listo en puerto ${PORT}`));
