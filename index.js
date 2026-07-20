import express from "express";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const app = express();
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
  console.error("Error cargando credenciales de Google Sheets:", e);
}

// Estructura de la herramienta MCP
const TOOL_DEF = {
  name: "consultar_producto",
  description: "Busca productos en la farmacia por nombre, descripción, SKU o código de barras en tiempo real.",
  inputSchema: {
    type: "object",
    properties: {
      busqueda: { type: "string", description: "Nombre, SKU o código de barras del producto" }
    },
    required: ["busqueda"]
  }
};

// Función para buscar datos en la planilla
async function buscarProducto(query) {
  if (!doc) return [];
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  const q = (query || '').toLowerCase();

  return rows.filter(row => {
    const descrip = (row.get('descrip') || '').toLowerCase();
    const sku = (row.get('sku') || '').toString().toLowerCase();
    const barras = (row.get('barras') || '').toString().toLowerCase();
    return descrip.includes(q) || sku.includes(q) || barras.includes(q);
  }).map(row => ({
    sku: row.get('sku'),
    barras: row.get('barras'),
    descripcion: row.get('descrip'),
    precio: row.get('precio'),
    stock: row.get('stock')
  })).slice(0, 5);
}

// Controlador unificado para GET y POST en cualquier ruta (/sse, /, /mcp)
const handleMCP = async (req, res) => {
  const body = req.body || {};
  const method = body.method;
  const id = body.id || 1;

  // 1. Invocación de herramienta
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

  // 2. Para cualquier otra consulta (tools/list, initialize, GET de prueba, etc.)
  return res.json({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      tools: [TOOL_DEF],
      serverInfo: { name: "mcp-sheets-farmacia", version: "1.0.0" }
    }
  });
};

app.all("*", handleMCP);

app.listen(PORT, () => console.log(`Servidor MCP escuchando en el puerto ${PORT}`));
